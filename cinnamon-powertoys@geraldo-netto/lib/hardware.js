/*
 * cinnamon-powertoys - what the hardware is called.
 *
 * The kernel names a device by where it is plugged in: 03:00.0 is a slot, not a
 * graphics card, and nobody reading a menu knows which of their two cards that
 * is. Every distribution that ships lspci also ships the table lspci reads -
 * pci.ids - and the four ids needed to look a device up in it are in sysfs
 * beside the device itself. So the address is only ever the last resort here.
 *
 * The table is 1.4 MB and is wanted for a handful of devices, so it is never
 * split into lines: a vendor's entries are one contiguous block and finding
 * that block is a substring search. It is read at most once per resolution and
 * dropped again immediately, while an answer - a few dozen bytes - is kept as
 * long as the device IDs at that address still identify the same hardware.
 */

const IO = require("./lib/io.js");

/*
 * Where pci.ids ends up. Debian and Ubuntu put it in misc and symlink hwdata at
 * it, Fedora and Arch do the reverse, and a few older trees have neither.
 */
var PCI_IDS_PATHS = [
    "/usr/share/misc/pci.ids",
    "/usr/share/hwdata/pci.ids",
    "/usr/share/pci.ids",
];

/* The monitor equivalent: three letter EDID manufacturer codes. */
var PNP_IDS_PATHS = [
    "/usr/share/hwdata/pnp.ids",
    "/usr/share/misc/pnp.ids",
];

var PCI_DEVICE_DIR = "/sys/bus/pci/devices";
var CPUINFO = "/proc/cpuinfo";

/* 0000:03:00.0 - domain, bus, device, function. */
var PCI_ADDRESS = /[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]/gi;

let _pciNames = {};
let _pnpNames = null;
let _pnpLoad = null;
let _pnpWaiters = [];
let _cpuName;

/* Everything cached here is a fact about hardware that does not change while
 * the applet runs, so this exists for the tests, which change the machine. */
function forget() {
    _pciNames = {};
    if (_pnpLoad && _pnpLoad.active)
        _pnpLoad.cancel();
    _pnpLoad = null;
    _pnpWaiters = [];
    _pnpNames = null;
    _cpuName = undefined;
}

function _firstReadable(paths) {
    for (let path of paths) {
        let text = IO.readString(path);
        if (text)
            return text;
    }
    return null;
}

/* ---------------------------------------------------------------- processor */

function _cpuInfoValue(text, key) {
    let match = new RegExp("^" + key + "\\s*:\\s*(.+)$", "mi").exec(text);
    return match ? match[1].trim() : null;
}

function _cpuNameFrom(text) {
    let raw = _cpuInfoValue(text, "model name") ||
              _cpuInfoValue(text, "Model") ||
              _cpuInfoValue(text, "Hardware");
    return tidyCpuName(raw);
}

/*
 * "Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz" is a marketing string with a
 * model number inside it. What is dropped is everything that is true of every
 * processor ever sold - that it is a CPU, that it is a processor, the symbols
 * a lawyer asked for - and the clock, which is in the menu two rows down and
 * measured rather than claimed.
 */
function tidyCpuName(raw) {
    if (!raw)
        return null;
    let name = String(raw)
        .replace(/\((?:R|TM|C)\)/gi, "")
        .replace(/\s+@.*$/, "")
        .replace(/\s+with\s+.*\bGraphics\b.*$/i, "")
        .replace(/\s+\d+-Core\s+Processor\b.*$/i, "")
        .replace(/\s+Processor\s*$/i, "")
        .replace(/\s+CPU\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    return name || null;
}

/*
 * What this machine's processor is called.
 *
 * "model name" is x86; ARM boards answer "Model" or, on a Raspberry Pi and its
 * imitators, only "Hardware", which names the SoC rather than the core. All
 * three are better than nothing at all.
 */
function cpuModelName() {
    if (_cpuName !== undefined)
        return _cpuName;

    let text = IO.readString(CPUINFO);
    if (text === null)
        return null;
    /* A readable file in an unsupported format is a confirmed absence. A
     * failed read is not, and is deliberately retried next time. */
    _cpuName = _cpuNameFrom(text);
    return _cpuName;
}

/* --------------------------------------------------------------------- PCI */

/*
 * The last PCI address in a sysfs path.
 *
 * A hwmon directory's device link points at whatever the driver bound to, which
 * for a graphics card is the card itself and for a disk is several levels below
 * the controller. Taking the last address in the path is therefore the nearest
 * PCI device to the sensor, which is the one worth naming.
 */
function pciAddressIn(path) {
    if (!path)
        return null;
    let found = String(path).match(PCI_ADDRESS);
    return found ? found[found.length - 1].toLowerCase() : null;
}

function _pciIdsFrom(address, readString) {
    let base = PCI_DEVICE_DIR + "/" + address;
    let read = node => {
        let raw = readString(base + "/" + node);
        let match = raw && /^0x([0-9a-f]{4})$/i.exec(raw.trim());
        return match ? match[1].toLowerCase() : null;
    };
    let vendor = read("vendor");
    let device = read("device");
    if (!vendor || !device)
        return null;
    return {
        vendor: vendor,
        device: device,
        subVendor: read("subsystem_vendor"),
        subDevice: read("subsystem_device"),
    };
}

function _pciIds(address) {
    return _pciIdsFrom(address, IO.readString);
}

function _pciIdentity(ids) {
    if (!ids)
        return null;
    return [ids.vendor, ids.device, ids.subVendor || "", ids.subDevice || ""].join(":");
}

function _cachedPciName(address, ids) {
    let cached = _pciNames[address];
    if (cached && cached.identity === _pciIdentity(ids))
        return cached.name;
    delete _pciNames[address];
    return null;
}

function _rememberPciName(address, ids, name) {
    _pciNames[address] = { identity: _pciIdentity(ids), name: name };
}

/*
 * One vendor's whole entry, from its own line to the line before the next
 * vendor. Vendor lines start at column zero; devices are indented by one tab
 * and subsystems by two, so the block boundary is the next unindented line -
 * which is either another vendor or the start of the class list.
 */
function _vendorBlock(text, vendor) {
    let start = text.indexOf("\n" + vendor + "  ");
    if (start < 0)
        return null;
    start += 1;

    let boundary = /\n(?=[0-9a-f]{4} {2}|C [0-9a-f]{2} {2})/g;
    boundary.lastIndex = start + 1;
    let end = boundary.exec(text);
    return text.slice(start, end ? end.index + 1 : text.length);
}

function _blockName(block) {
    let newline = block.indexOf("\n");
    let line = newline < 0 ? block : block.slice(0, newline);
    let separator = line.indexOf("  ");
    return separator < 0 ? "" : line.slice(separator + 2).trim();
}

/*
 * A vendor as it would be said out loud. pci.ids gives the registered company
 * name, and the part anyone recognises is either in brackets at the end -
 * "Advanced Micro Devices, Inc. [AMD/ATI]" - or is the first word of it.
 */
function vendorShortName(name) {
    if (!name)
        return "";
    let bracket = /\[([^\]]+)\]/.exec(name);
    if (bracket)
        return bracket[1].split("/")[0].trim();
    return name.split(/[\s,]+/)[0];
}

/*
 * A device as it would be said out loud.
 *
 * pci.ids names a chip by its codename and puts the name it was sold under in
 * brackets after it: "Navi 23 [Radeon RX 6600/6600 XT/6600M]". The bracketed
 * name is the one on the box, and it names its own vendor, so it is taken
 * whole - including the alternatives, which are there because one chip id is
 * shared by several cards and choosing between them would be asserting
 * something the hardware has not said. A chip with no bracketed name is only a
 * codename, so it gets its vendor in front of it: "AMD Raphael".
 */
function deviceDisplayName(deviceName, vendorName) {
    if (!deviceName)
        return null;
    let bracket = /\[([^\]]+)\]\s*$/.exec(deviceName);
    if (bracket)
        return bracket[1].trim();
    let vendor = vendorShortName(vendorName);
    return vendor ? vendor + " " + deviceName : deviceName;
}

/* One device's entry inside a vendor block, subsystems and all. */
function _deviceBlock(block, device) {
    let start = block.indexOf("\n\t" + device + "  ");
    if (start < 0)
        return null;
    start += 1;
    let boundary = /\n(?!\t\t)/g;
    boundary.lastIndex = start + 1;
    let end = boundary.exec(block);
    return block.slice(start, end ? end.index + 1 : block.length);
}

function _subsystemName(deviceBlock, subVendor, subDevice) {
    let match = new RegExp("^\\t\\t" + subVendor + " " + subDevice + "  (.*)$", "m")
        .exec(deviceBlock);
    return match ? match[1].trim() : null;
}

function _resolve(text, ids) {
    let vendorBlock = _vendorBlock(text, ids.vendor);
    if (!vendorBlock)
        return null;
    let vendorName = _blockName(vendorBlock);

    let deviceBlock = _deviceBlock(vendorBlock, ids.device);
    if (!deviceBlock)
        return vendorName ? vendorShortName(vendorName) : null;

    /*
     * The board before the chip. A subsystem id names the card somebody bought
     * - "XFX Speedster SWFT 210 Radeon RX 6600" - where the device id names
     * only the chip on it. Most cards are not in the table under their
     * subsystem, which is why this is a preference and not the whole answer.
     */
    if (ids.subVendor && ids.subDevice && ids.subVendor !== "0000") {
        let board = _subsystemName(deviceBlock, ids.subVendor, ids.subDevice);
        if (board) {
            let subVendorName = vendorShortName(_blockName(_vendorBlock(text, ids.subVendor) || ""));
            if (!subVendorName ||
                board.toLowerCase().indexOf(subVendorName.toLowerCase()) === 0)
                return board;
            return subVendorName + " " + board;
        }
    }

    return deviceDisplayName(_blockName(deviceBlock), vendorName);
}

/*
 * Names for several PCI addresses at once, as an object of address to name.
 *
 * Together rather than one at a time because the table is read for the batch
 * and thrown away after it; asking for six devices one by one would read 1.4 MB
 * six times. An address that cannot be named is absent from the answer rather
 * than present and null, so a caller can ask with `names[address] ||
 * something-else`.
 *
 * Only answers tied to the four current PCI IDs are remembered. An external
 * card, dock or bus rescan can put a different device at the same address;
 * missing IDs and unresolved names are not cached.
 */
function pciDeviceNames(addresses) {
    let names = {};
    let wanted = [];
    let seen = new Set();

    for (let address of addresses) {
        if (!address || seen.has(address))
            continue;
        seen.add(address);
        let ids = _pciIds(address);
        if (!ids) {
            delete _pciNames[address];
            continue;
        }
        let cached = _cachedPciName(address, ids);
        if (cached)
            names[address] = cached;
        else
            wanted.push({ address: address, ids: ids });
    }

    if (wanted.length === 0)
        return names;

    let text = _firstReadable(PCI_IDS_PATHS);
    if (!text)
        return names;

    for (let item of wanted) {
        let name = _resolve(text, item.ids);
        if (name) {
            _rememberPciName(item.address, item.ids, name);
            names[item.address] = name;
        }
    }
    return names;
}

/*
 * The two hardware-name lookups sensor discovery needs, read as one batch off
 * the main loop. pci.ids is the expensive member of that batch; loading it
 * asynchronously is what keeps a first sensor sweep from pausing the panel.
 */
function machineNamesAsync(addresses, onDone, ioOptions) {
    let names = {};
    let unique = [];
    for (let address of addresses) {
        if (address && unique.indexOf(address) < 0)
            unique.push(address);
    }

    let paths = [];
    if (_cpuName === undefined)
        paths.push(CPUINFO);
    for (let address of unique) {
        let base = PCI_DEVICE_DIR + "/" + address;
        paths.push(base + "/vendor", base + "/device",
                   base + "/subsystem_vendor", base + "/subsystem_device");
    }

    IO.readStringsAsync(paths, values => {
        if (_cpuName === undefined) {
            let text = values[CPUINFO];
            if (text !== null && text !== undefined)
                _cpuName = _cpuNameFrom(text);
        }

        let wanted = [];
        for (let address of unique) {
            let ids = _pciIdsFrom(address, path => values[path] || null);
            if (!ids) {
                delete _pciNames[address];
                continue;
            }
            let cached = _cachedPciName(address, ids);
            if (cached)
                names[address] = cached;
            else
                wanted.push({ address: address, ids: ids });
        }

        if (wanted.length === 0) {
            onDone({ cpuName: _cpuName === undefined ? null : _cpuName,
                     pciNames: names });
            return;
        }

        IO.readStringsAsync(PCI_IDS_PATHS, tables => {
            let table = null;
            for (let path of PCI_IDS_PATHS) {
                if (tables[path]) {
                    table = tables[path];
                    break;
                }
            }
            if (table) {
                for (let item of wanted) {
                    let name = _resolve(table, item.ids);
                    if (!name)
                        continue;
                    _rememberPciName(item.address, item.ids, name);
                    names[item.address] = name;
                }
            }
            onDone({ cpuName: _cpuName === undefined ? null : _cpuName,
                     pciNames: names });
        }, PCI_IDS_PATHS.length, null, ioOptions);
    }, undefined, null, ioOptions);
}

/* ----------------------------------------------------------------- monitors */

/*
 * Company names as registered, tidied to what is on the front of the monitor.
 * "LG Electronics" is LG, "Samsung Electric Company" is Samsung. The words
 * dropped are the ones that appear in hundreds of these entries and identify
 * nothing.
 */
const COMPANY_WORDS = [
    "inc", "inc.", "llc", "ltd", "ltd.", "limited", "co", "co.", "corp",
    "corp.", "corporation", "company", "gmbh", "ag", "sa", "s.a.", "bv",
    "b.v.", "plc", "electronics", "electronic", "electric", "technologies",
    "technology", "tech", "international", "industries", "industrial",
    "group", "computer", "computers", "display", "displays", "optronics",
    "america", "usa",
];

function tidyVendorName(name) {
    let words = String(name || "").trim().split(/\s+/);
    while (words.length > 1 &&
           COMPANY_WORDS.indexOf(words[words.length - 1].toLowerCase().replace(/,$/, "")) >= 0)
        words.pop();
    return words.join(" ").replace(/,$/, "");
}

/*
 * pnp.ids, as a table of the three letter code EDID carries to the company that
 * registered it. Small enough - sixty kilobytes - to keep, unlike pci.ids.
 * Loading is asynchronous because monitor discovery completes on Cinnamon's
 * main thread and even this small cold file read can pause panel rendering.
 */
function _pnpTable() {
    return _pnpNames || {};
}

function _pnpTableFrom(values) {
    let names = {};
    let readable = false;
    for (let path of PNP_IDS_PATHS) {
        let text = values[path];
        if (text === null || text === undefined)
            continue;
        readable = true;
        for (let line of text.split("\n")) {
            let match = /^([A-Za-z]{3})\s+(.+)$/.exec(line);
            if (match)
                names[match[1].toUpperCase()] = match[2].trim();
        }
        if (Object.keys(names).length > 0)
            break;
    }
    return { readable: readable, names: names };
}

/* Coalesce callers while the shared table is loading. A failed read is not
 * cached, so the next DDC discovery gets another chance; a readable empty or
 * unsupported table is a confirmed answer and is retained. */
function loadPnpNamesAsync(onDone, ioOptions) {
    let done = onDone || function () {};
    if (_pnpNames !== null) {
        done(true);
        return null;
    }

    _pnpWaiters.push(done);
    if (_pnpLoad)
        return _pnpLoad;

    let marker = {};
    _pnpLoad = marker;
    let operation = IO.readStringsAsync(PNP_IDS_PATHS, values => {
        _pnpLoad = null;
        let answer = _pnpTableFrom(values);
        if (answer.readable)
            _pnpNames = answer.names;
        let waiters = _pnpWaiters.splice(0);
        for (let waiter of waiters)
            waiter(answer.readable);
    }, PNP_IDS_PATHS.length, null, ioOptions);
    if (_pnpLoad === marker)
        _pnpLoad = operation && operation.active ? operation : null;
    return operation;
}

/*
 * What a monitor's EDID manufacturer code stands for. Unknown codes come back
 * as themselves, which is right more often than it sounds: the codes are three
 * letters chosen by the company, and AOC, BNQ and HPN are readable already.
 */
function monitorVendorName(code) {
    if (!code)
        return "";
    let upper = String(code).toUpperCase();
    let registered = _pnpTable()[upper];
    return registered ? tidyVendorName(registered) : upper;
}

/*
 * A monitor as one line: who made it and which model it is.
 *
 * EDID keeps those apart, and the model string sometimes repeats the maker -
 * "DELL U2415" - so the maker is only put in front when it is not already
 * there, and a model that starts with the code is rewritten to start with the
 * name instead. The serial number is deliberately not part of this: it
 * identifies a particular piece of hardware, and a menu row does not need to.
 */
function monitorName(code, model) {
    let vendor = monitorVendorName(code);
    let name = String(model || "").trim();
    if (!name)
        return vendor || "";
    if (!vendor)
        return name;

    let first = name.split(/\s+/)[0];
    let vendorFirst = vendor.split(/\s+/)[0];
    if (first.toUpperCase() === vendorFirst.toUpperCase() ||
        first.toUpperCase() === String(code).toUpperCase())
        return vendor + name.slice(first.length);
    if (name.toLowerCase().indexOf(vendor.toLowerCase()) === 0)
        return name;
    return vendor + " " + name;
}
