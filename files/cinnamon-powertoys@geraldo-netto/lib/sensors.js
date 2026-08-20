/*
 * cinnamon-powertoys - temperature, fan and power sensor discovery.
 *
 * Covers hwmon, the thermal zones hwmon does not already account for, and the
 * powercap energy counters. Discovery records where to read and what the
 * reading is called; the values themselves are read later, one poll at a time.
 */

const GLib = imports.gi.GLib;

const Format = require("./lib/format.js");
const Hardware = require("./lib/hardware.js");
const IO = require("./lib/io.js");
const Kinds = require("./lib/sensor-kinds.js");
const Once = require("./lib/once.js");
const Refresh = require("./lib/refresh.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const HWMON_DIR = "/sys/class/hwmon";
const THERMAL_DIR = "/sys/class/thermal";
const POWERCAP_DIR = "/sys/class/powercap";

function _label(base, prefix, index, readString) {
    let read = readString || IO.readString;
    return read(base + "/" + prefix + index + "_label");
}

/*
 * Something to tell two chips of the same name apart: the block device for
 * drivetemp, the PCI slot for two amdgpu cards, the controller name for nvme.
 */
function _hwmonIdentity(base, listDir, readLink) {
    let list = listDir || IO.listDir;
    let link = readLink || IO.readLink;
    let block = list(base + "/device/block");
    if (block.length > 0)
        return block[0];
    let target = link(base + "/device");
    if (target) {
        let name = GLib.path_get_basename(target);
        /* 0000:03:00.0 reads better as 03:00.0 */
        return name.replace(/^0000:/, "");
    }
    return null;
}

/* The device behind a class entry, as one canonical path. hwmon and thermal
 * expose different class symlinks for the same hardware, so their raw link
 * text cannot be compared directly. No link means no evidence of a duplicate:
 * a display name alone is not an identity. */
function deviceIdentity(base, readLink) {
    let link = readLink || IO.readLink;
    let target = link(base + "/device");
    if (!target)
        return null;
    let parent = GLib.path_get_dirname(IO.resolve(base + "/device"));
    return GLib.canonicalize_filename(target, parent);
}

/*
 * The three kinds of hwmon node.
 *
 * They are the same scan: find nodeN_input, read the label beside it, record
 * where to read the value. What differs is the name, and whether anything
 * else has to be picked up along with it. Written out three times, the three
 * copies drifted - "measure" was added to two of them before the third.
 */
const NODE_KINDS = [
    {
        prefix: "temp",
        measure: "temperature",
        list: "temperatures",
        pattern: /^temp(\d+)_input$/,
        fault: true,
        /* The chip's own limit, which is what a reading gets flagged
         * against. Some drivers only publish the emergency one. */
        extra: function (base, index, readNumber) {
            let read = readNumber || IO.readNumber;
            let critical = read(base + "/temp" + index + "_crit");
            if (critical === null)
                critical = read(base + "/temp" + index + "_emergency");
            return { critical: critical === null ? null : critical / 1000 };
        },
    },
    {
        prefix: "fan",
        measure: "fan",
        list: "fans",
        pattern: /^fan(\d+)_input$/,
        fault: true,
    },
    {
        prefix: "power",
        measure: "power",
        list: "powerMeters",
        /* powerN_average is the driver's own averaged value, powerN_input the
         * instantaneous one. Both are microwatts. */
        pattern: /^power(\d+)_(average|input)$/,
        skip: function (base, index, match, exists) {
            let present = exists || IO.exists;
            return match[2] === "input" && present(base + "/power" + index + "_average");
        },
    },
];

/*
 * A channel that may stand for one whole graphics device.
 *
 * Several hwmon channels from one card are not necessarily additive: one can
 * be the board and the others its rails. A driver's explicit total label is
 * the contract; a lone unlabelled channel is the common power1 whole-device
 * interface and has nothing beside it to double count. Anything else remains
 * an individual tooltip reading only.
 */
const GPU_TOTAL_LABEL = /^(ppt|total(?: power)?|board power|gpu power|graphics power|package power)$/i;

function gpuDeviceTotal(meters) {
    if (meters.length === 1 && !meters[0].rawLabel)
        return meters[0];
    let explicit = meters.filter(meter => GPU_TOTAL_LABEL.test(
        String(meter.rawLabel || "").trim().replace(/[_-]+/g, " ")));
    return explicit.length === 1 ? explicit[0] : null;
}

/*
 * Discovers every temperature, fan and power meter exposed by hwmon plus any
 * thermal zone that hwmon does not already cover. Values are not read here,
 * only the paths to read later.
 */
function _directoryInventory() {
    let directories = {};
    let roots = [HWMON_DIR, THERMAL_DIR, POWERCAP_DIR];
    for (let root of roots)
        directories[root] = IO.listDir(root);
    for (let entry of directories[HWMON_DIR]) {
        let base = HWMON_DIR + "/" + entry;
        directories[base] = IO.listDir(base);
        directories[base + "/device/block"] = IO.listDir(base + "/device/block");
    }
    for (let entry of directories[THERMAL_DIR]) {
        let base = THERMAL_DIR + "/" + entry;
        directories[base] = IO.listDir(base);
    }
    return directories;
}

function _listDirectoriesAsync(paths, directories, onDone, ioOptions) {
    if (paths.length === 0) {
        onDone();
        return;
    }
    IO.listDirsAsync(paths, values => {
        Object.assign(directories, values);
        onDone();
    }, 8, null, ioOptions);
}

/* Directory enumeration is asynchronous too, and one bounded listing is made
 * per directory. The arrays form one immutable inventory for the rest of the
 * sweep, so hardware moving during it is caught by the next topology check. */
function _directoryInventoryAsync(onDone, ioOptions) {
    let directories = {};
    _listDirectoriesAsync([HWMON_DIR, THERMAL_DIR, POWERCAP_DIR], directories, () => {
        let children = [];
        for (let entry of directories[HWMON_DIR]) {
            let base = HWMON_DIR + "/" + entry;
            children.push(base, base + "/device/block");
        }
        for (let entry of directories[THERMAL_DIR])
            children.push(THERMAL_DIR + "/" + entry);
        _listDirectoriesAsync(children, directories, () => onDone(directories), ioOptions);
    }, ioOptions);
}

function _hwmonMetadataPaths(list) {
    let paths = [];
    for (let entry of list(HWMON_DIR)) {
        let base = HWMON_DIR + "/" + entry;
        paths.push(base + "/name");
        for (let node of list(base)) {
            for (let nodeKind of NODE_KINDS) {
                let match = node.match(nodeKind.pattern);
                if (!match)
                    continue;
                let index = match[1];
                paths.push(base + "/" + nodeKind.prefix + index + "_label");
                if (nodeKind.prefix === "temp") {
                    paths.push(base + "/temp" + index + "_crit",
                               base + "/temp" + index + "_emergency");
                }
                break;
            }
        }
    }
    return paths;
}

function _thermalMetadataPaths(list) {
    let paths = [];
    for (let entry of list(THERMAL_DIR)) {
        if (!/^thermal_zone\d+$/.test(entry))
            continue;
        let base = THERMAL_DIR + "/" + entry;
        paths.push(base + "/type");
        for (let node of list(base)) {
            let match = node.match(/^trip_point_(\d+)_type$/);
            if (match)
                paths.push(base + "/" + node,
                           base + "/trip_point_" + match[1] + "_temp");
        }
    }
    return paths;
}

function _powercapMetadataPaths(list) {
    let paths = [];
    for (let entry of list(POWERCAP_DIR)) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        paths.push(base + "/energy_uj", base + "/power_uw", base + "/name",
                   base + "/max_energy_range_uj");
    }
    return paths;
}

function _metadataPaths(directories) {
    let list = path => directories[path] || [];
    let paths = _hwmonMetadataPaths(list)
        .concat(_thermalMetadataPaths(list), _powercapMetadataPaths(list));
    return Array.from(new Set(paths));
}

function _linkPaths(directories) {
    let paths = [];
    for (let entry of directories[HWMON_DIR] || [])
        paths.push(HWMON_DIR + "/" + entry + "/device");
    for (let entry of directories[THERMAL_DIR] || [])
        paths.push(THERMAL_DIR + "/" + entry + "/device");
    return paths;
}

function _hwmonNodeSensor(node, context) {
    for (let nodeKind of NODE_KINDS) {
        let match = node.match(nodeKind.pattern);
        if (!match)
            continue;
        let index = match[1];
        if (nodeKind.skip?.(context.base, index, match, context.exists))
            return null;

        let sensor = {
            id: "hwmon:" + context.entry + ":" + nodeKind.prefix + index,
            measure: nodeKind.measure,
            source: "hwmon",
            chip: context.chip,
            kind: context.kind,
            group: context.group,
            index: index,
            identity: context.identity,
            deviceIdentity: context.device,
            rawLabel: _label(context.base, nodeKind.prefix, index, context.readString),
            path: context.base + "/" + node,
        };
        if (nodeKind.prefix === "power" && match[2] === "average") {
            let input = context.base + "/power" + index + "_input";
            sensor.fallbackPath = context.exists(input) ? input : null;
        }
        let faultPath = context.base + "/" + nodeKind.prefix + index + "_fault";
        sensor.faultPath = nodeKind.fault && context.exists(faultPath) ? faultPath : null;
        Object.assign(sensor, nodeKind.extra?.(context.base, index, context.readNumber));
        return { list: nodeKind.list, sensor: sensor };
    }
    return null;
}

function _scanHwmonEntry(entry, state) {
    let base = HWMON_DIR + "/" + entry;
    let chip = state.readString(base + "/name") || entry;
    let kind = Kinds.classifyChip(chip);
    let identity = _hwmonIdentity(base, state.list, state.link);
    let device = deviceIdentity(base, state.link);
    let group = "hwmon:" + entry;
    state.groups.push({
        key: group,
        chip: chip,
        kind: kind,
        identity: identity,
        pciAddress: Hardware.pciAddressIn(state.link(base + "/device")),
    });

    let ofThisChip = { temperatures: [], fans: [], powerMeters: [] };
    let context = {
        entry: entry, base: base, chip: chip, kind: kind, group: group,
        identity: identity, device: device, exists: state.exists,
        readString: state.readString, readNumber: state.readNumber,
    };
    for (let node of state.list(base)) {
        let found = _hwmonNodeSensor(node, context);
        if (found)
            ofThisChip[found.list].push(found.sensor);
    }

    if (kind === "gpu") {
        let total = gpuDeviceTotal(ofThisChip.powerMeters);
        for (let meter of ofThisChip.powerMeters)
            meter.deviceTotal = meter === total;
    }
    /* How many of its own kind this chip has, which decides whether an
     * unlabelled sensor needs its index in the name. */
    for (let listName in ofThisChip) {
        for (let sensor of ofThisChip[listName])
            sensor.siblings = ofThisChip[listName].length;
        state.found[listName] = state.found[listName].concat(ofThisChip[listName]);
    }
    if (device && ofThisChip.temperatures.length > 0)
        state.hwmonTemperatureDevices.add(device);
}

function _scanThermalEntry(entry, state) {
    if (!/^thermal_zone\d+$/.test(entry))
        return;
    let base = THERMAL_DIR + "/" + entry;
    let type = state.readString(base + "/type");
    if (!type)
        return;
    let device = deviceIdentity(base, state.link);
    state.groups.push({ key: "thermal:" + entry, chip: type, kind: Kinds.classifyChip(type),
                        identity: entry, pciAddress: null });
    state.found.temperatures.push({
        id: "thermal:" + entry,
        measure: "temperature",
        source: "thermal",
        chip: type,
        kind: Kinds.classifyChip(type),
        group: "thermal:" + entry,
        index: "1",
        siblings: 1,
        identity: entry,
        deviceIdentity: device,
        fallbackForDevice: device && state.hwmonTemperatureDevices.has(device)
            ? device : null,
        rawLabel: null,
        path: base + "/temp",
        critical: _criticalTripPoint(base, state.list, state.readString),
    });
}

function _scanSensors(directories, readString, readLink) {
    let state = {
        found: { temperatures: [], fans: [], powerMeters: [] },
        hwmonTemperatureDevices: new Set(),
        groups: [],
        list: path => directories[path] || [],
        link: readLink || IO.readLink,
        readString: readString,
        readNumber: path => IO.toNumber(readString(path)),
    };
    state.exists = path => {
        let parent = GLib.path_get_dirname(path);
        return state.list(parent).includes(GLib.path_get_basename(path));
    };
    for (let entry of state.list(HWMON_DIR))
        _scanHwmonEntry(entry, state);
    for (let entry of state.list(THERMAL_DIR))
        _scanThermalEntry(entry, state);
    return { found: state.found, groups: state.groups };
}

function _finishSensors(scanned, groupLabels) {
    let found = scanned.found;
    /* One pass over everything, then split back out by what it measures. */
    let named = Kinds.finalizeNames(found.temperatures.concat(found.fans, found.powerMeters))
        .map(entry => ({ ...entry, groupLabel: groupLabels[entry.group] || "" }));
    return {
        temperatures: named.filter(entry => entry.measure === "temperature"),
        fans: named.filter(entry => entry.measure === "fan"),
        powerMeters: named.filter(entry => entry.measure === "power"),
    };
}

function discoverSensors() {
    let directories = _directoryInventory();
    let scanned = _scanSensors(directories, IO.readString);
    return _finishSensors(scanned, Kinds.nameGroups(scanned.groups));
}

function _criticalTripPoint(base, listDir, readString) {
    let list = listDir || IO.listDir;
    let read = readString || IO.readString;
    for (let node of list(base)) {
        let match = node.match(/^trip_point_(\d+)_type$/);
        if (!match)
            continue;
        let type = read(base + "/" + node);
        if (type !== "critical")
            continue;
        let value = IO.toNumber(read(base + "/trip_point_" + match[1] + "_temp"));
        if (value !== null)
            return value / 1000;
    }
    return null;
}

/*
 * A RAPL domain directory is named intel-rapl:0 for a whole package and
 * intel-rapl:0:1 for one of its parts, so the top level ones are exactly the
 * domains that can be added up without counting the same joules twice.
 */
const RAPL_PACKAGE_DOMAIN = /^(intel|amd)-rapl:\d+$/;

/*
 * What powercap calls a domain, said in words.
 *
 * The kernel's names are "package-0" for a socket and, inside it, "core" for
 * the cores, "uncore" for the graphics and the rest of the die, "dram" for
 * the memory and "psys" for the whole board where the firmware measures that.
 * A machine with one socket has nothing to tell apart, so its package is just
 * the package; where there are several, each keeps its number.
 */
const RAPL_NAMES = [
    [/^core$/i, () => _("Cores")],
    [/^uncore$/i, () => _("Uncore")],
    [/^dram$/i, () => _("Memory")],
    [/^psys$/i, () => _("Whole board")],
];

function _raplName(raw, packages) {
    let match = /^package-(\d+)$/i.exec(raw);
    if (match)
        return packages > 1 ? Translate.interpolate(
            _("Package %{number}"), { number: match[1] }) : _("Package");
    for (let [pattern, name] of RAPL_NAMES) {
        if (pattern.test(raw))
            return name();
    }
    return raw;
}

/*
 * RAPL / powercap energy counters. Since CVE-2020-8694 energy_uj is usually
 * 0400, so this returns an empty list on most systems - that is expected and
 * simply means no package power readout. README says how to hand it back, and
 * what is being handed back with it.
 */
function _energyCounters(entries, readString, canRead) {
    let found = [];
    let readable = canRead || (path => readString(path) !== null);
    let readNumber = path => IO.toNumber(readString(path));
    for (let entry of entries) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let energyPath = base + "/energy_uj";
        /* DTPM's native interface is an instantaneous power value. Prefer it
         * when present rather than exposing the same domain twice. */
        if (entry.startsWith("dtpm") && readable(base + "/power_uw"))
            continue;
        if (!readable(energyPath))
            continue;
        found.push({
            entry: entry,
            base: base,
            energyPath: energyPath,
            raw: readString(base + "/name") || entry,
        });
    }

    /* Counted before anything is named, because whether one package needs its
     * number said depends on how many there are. */
    let packages = found.filter(item => /^package-\d+$/i.test(item.raw)).length;

    return found.map(item => ({
        id: "rapl:" + item.entry,
        measure: "power",
        kind: "package",
        /* Not a chip, so it has no chip's name to be grouped under; the
         * kind is what these have in common and all they have. */
        group: "rapl",
        label: _raplName(item.raw, packages),
        path: item.energyPath,
        maxRange: readNumber(item.base + "/max_energy_range_uj"),
        domain: item.entry,
        topLevel: RAPL_PACKAGE_DOMAIN.test(item.entry),
    }));
}

/* DTPM domains expose instantaneous microwatts rather than an energy counter.
 * Only a root domain is a platform aggregate; its children remain individual
 * rows and are never added to it. */
function _directPowercapSensors(entries, readString, canRead) {
    let found = [];
    let readable = canRead || (path => readString(path) !== null);
    for (let entry of entries) {
        if (!/^dtpm(?::\d+)+$/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let path = base + "/power_uw";
        if (!readable(path))
            continue;
        let topLevel = /^dtpm:\d+$/.test(entry);
        let raw = readString(base + "/name") || entry;
        let label = topLevel ? _("Total") : Format.capitalize(raw);
        found.push({
            id: "dtpm-power:" + entry,
            measure: "power",
            source: "powercap",
            kind: topLevel ? "package" : "other",
            group: "dtpm",
            groupLabel: "DTPM",
            rawLabel: raw,
            label: label,
            display: label,
            short: label,
            path: path,
            platformTotal: topLevel,
        });
    }
    return found;
}

function discoverDirectPowercapSensors() {
    return _directPowercapSensors(IO.listDir(POWERCAP_DIR), IO.readString, IO.canRead);
}

function discoverEnergyCounters() {
    return _energyCounters(IO.listDir(POWERCAP_DIR), IO.readString, IO.canRead);
}

function _powercapTopology(entries, readable) {
    return entries.map(entry => {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            return entry;
        let base = POWERCAP_DIR + "/" + entry;
        let interfaces = [];
        if (readable(base + "/energy_uj"))
            interfaces.push("energy");
        if (readable(base + "/power_uw"))
            interfaces.push("power");
        return entry + ":" + (interfaces.join("+") || "restricted");
    }).join(",");
}

function _powercapAccessPaths(entries) {
    let paths = [];
    for (let entry of entries) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        paths.push(base + "/energy_uj", base + "/power_uw");
    }
    return paths;
}

function _nestedTopology(directories, root) {
    return (directories[root] || []).map(entry => {
        let base = root + "/" + entry;
        return entry + "[" + (directories[base] || []).join(",") + "]";
    }).join(",");
}

function _topologyFromInventory(directories, readString, readLink, canRead) {
    let powercap = directories[POWERCAP_DIR] || [];
    let metadata = _metadataPaths(directories)
        /* The counter value moves continuously; only whether it can be read
         * is topology, and that is represented by _powercapTopology. */
        .filter(path => !/\/(?:energy_uj|power_uw)$/.test(path))
        .map(path => [path, readString(path)]);
    let links = _linkPaths(directories).map(path => [path, readLink(path)]);
    return JSON.stringify([
        _nestedTopology(directories, HWMON_DIR),
        _nestedTopology(directories, THERMAL_DIR),
        _powercapTopology(powercap, canRead || (path => readString(path) !== null)),
        metadata,
        links,
    ]);
}

/*
 * One asynchronous sweep of sysfs, and the three readers built on it.
 *
 * The directory listing, the metadata load with its moving-value filter, the
 * device links and the powercap access check are the same four questions
 * whether the answer is wanted as a topology key or as a whole snapshot, and
 * they were written out twice - a tri-null barrier each, the same regular
 * expression each, the same three adapters each. A rule corrected in one copy
 * was a rule still wrong in the other. Nothing here blocks Cinnamon's main
 * thread.
 */
function _loadInventoryAsync(onDone, ioOptions) {
    _directoryInventoryAsync(directories => {
        let metadata = null;
        let links = null;
        let access = null;
        let finish = () => {
            if (metadata === null || links === null || access === null)
                return;
            onDone({
                directories: directories,
                read: path => metadata[path] === undefined ? null : metadata[path],
                readLink: path => links[path] === undefined ? null : links[path],
                readable: path => access[path] === true,
            });
        };
        /* Values that move on every reading are excluded; everything retained
         * is something discovery uses to classify or name a sensor. */
        IO.readStringsAsync(_metadataPaths(directories).filter(path =>
            !/\/(?:energy_uj|power_uw)$/.test(path)), values => {
            metadata = values;
            finish();
        }, 32, null, ioOptions);
        IO.readLinksAsync(_linkPaths(directories), values => {
            links = values;
            finish();
        }, 32, null, ioOptions);
        IO.pathsReadableAsync(_powercapAccessPaths(directories[POWERCAP_DIR] || []),
            values => {
                access = values;
                finish();
            }, 32, null, ioOptions);
    }, ioOptions);
}

/* The refresh check's answer: what is present, from one loaded inventory. */
function _inventoryTopology(inventory) {
    return _topologyFromInventory(inventory.directories, inventory.read,
                                  inventory.readLink, inventory.readable);
}

/*
 * One complete sensor snapshot from an inventory already in hand, assembled
 * only after the machine names have answered too. Separate from the sweep so
 * that a refresh which has just swept can go straight on to the snapshot
 * rather than sweeping a second time to build it.
 */
function snapshotFromInventoryAsync(inventory, onDone, ioOptions) {
    let read = inventory.read;
    let readable = inventory.readable;
    let powercap = inventory.directories[POWERCAP_DIR] || [];
    let scanned = _scanSensors(inventory.directories, read, inventory.readLink);
    let addresses = scanned.groups.map(group => group.pciAddress);
    Hardware.machineNamesAsync(addresses, names => {
        let labels = Kinds.nameGroupsFrom(scanned.groups, names.cpuName, names.pciNames);
        onDone({
            sensors: _finishSensors(scanned, labels),
            counters: _energyCounters(powercap, read, readable),
            directPowers: _directPowercapSensors(powercap, read, readable),
            topology: _inventoryTopology(inventory),
        });
    }, ioOptions);
}

/* One complete sensor snapshot, assembled only after every asynchronous part
 * has answered. Until this callback, callers keep using the prior snapshot. */
function discoverSnapshotAsync(onDone, ioOptions) {
    _loadInventoryAsync(inventory =>
        snapshotFromInventoryAsync(inventory, onDone, ioOptions), ioOptions);
}

function discoverSensorsAsync(onDone, ioOptions) {
    discoverSnapshotAsync(snapshot => onDone(snapshot.sensors), ioOptions);
}

/* Turns a monotonic microjoule counter into watts. */
const EnergyMeter = class EnergyMeter {
    constructor(counter) {
        this.counter = counter;
        this.id = counter.id;
        this.measure = counter.measure;
        this.kind = counter.kind;
        this.label = counter.label;
        this.group = counter.group;
        this.domain = counter.domain;
        /* whether this counter may be added into a whole-package total */
        this.topLevel = counter.topLevel;
        this.watts = null;
        this._lastValue = null;
        this._lastTime = 0;
    }

    /*
     * Advances the counter, and answers nothing.
     *
     * What it produced is `watts`, which is null until two readings far
     * enough apart have been taken. It used to return that value and, when
     * the pair was unusable, quietly return the one before it - so a caller
     * could not tell a fresh reading from a stale one. Now an unusable pair
     * says so.
     *
     * `now` is the monotonic clock in microseconds, and is a parameter only
     * so the arithmetic can be exercised without waiting for real time to
     * pass. `readNumber` is where the counter is read from, which is how the
     * same meter works against a value already loaded off the main loop.
     */
    sample(now, readNumber) {
        let read = readNumber || IO.readNumber;
        let value = read(this.counter.path);
        let taken = now === undefined ? GLib.get_monotonic_time() : now;

        if (value === null) {
            this.watts = null;
            this._lastValue = null;
            return;
        }

        if (this._lastValue === null) {
            /* First reading: nothing to subtract from. */
            this.watts = null;
        } else {
            let energy = value - this._lastValue;
            if (energy < 0) {
                /* A falling counter may have wrapped, or somebody may have
                 * reset energy_uj to zero through the powercap ABI. Only
                 * values on opposite edges of the range are evidence of a
                 * wrap; every ambiguous fall is discarded and rebaselined. */
                let range = this.counter.maxRange;
                let wrapped = range && value > 0 &&
                    this._lastValue >= range * 0.75 && value <= range * 0.25;
                energy = wrapped ? energy + range : -1;
            }
            let elapsed = taken - this._lastTime;
            /* microjoules per microsecond is watts */
            this.watts = (elapsed > 0 && energy >= 0) ? energy / elapsed : null;
        }

        this._lastValue = value;
        this._lastTime = taken;
    }
};

/*
 * What sensors this machine has, and noticing when that changes.
 *
 * Discovery is the expensive half - every hwmon directory listed, every label
 * file opened - and it only changes when hardware does, so it happens once
 * and the result is kept. Two independent coalescing rules live here and
 * nowhere else: one discovery at a time with at most one replay behind it,
 * and one topology check at a time with at most one recheck behind it, since
 * a menu opened five times in a second must not put five sweeps of sysfs on
 * the bus.
 *
 * Nothing here reads a sensor value. What the values mean is SensorReader's.
 */
const SensorInventory = class SensorInventory {
    constructor(options) {
        let configuration = options || {};
        this._topology = null;
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        this._asynchronous = !!configuration.asynchronous;
        this._onChanged = configuration.onChanged || function () {};
        this._io = configuration.io || {};
        this._discovering = false;
        this._discoverAgain = false;
        this._discoverWaiters = [];
        this._discoverNextWaiters = [];
        /* One topology check at a time and one replay however many callers
         * asked; lib/refresh.js owns that. It also holds a check requested
         * during the first full discovery, which is what `defer` is for: that
         * discovery establishes the topology the check would compare against,
         * so there is nothing to compare until it lands. */
        this._refresh = new Refresh.Coalescer({
            sweep: done => this._sweep(done),
            defer: () => this._discovering,
        });
        this._destroyed = false;
    }

    start() {
        if (this._asynchronous)
            this.discoverAsync();
        else
            this.discover();
    }

    /* What was discovered, as one thing that can be held on to. */
    lists() {
        return {
            temperatures: this.temperatureSensors,
            fans: this.fanSensors,
            meters: this.energyMeters,
            powers: this.powerSensors,
        };
    }

    discover() {
        if (this._destroyed)
            return;
        let found = discoverSensors();
        this._adopt(found, discoverEnergyCounters(), this._topologyKey(),
                    discoverDirectPowercapSensors());
    }

    /*
     * A complete sweep, adopted when it lands.
     *
     * `inventory` is an optional sweep already in hand: the refresh check has
     * just read every path this needs, so when it finds the machine changed
     * the snapshot is assembled from what it read rather than from a second
     * walk of sysfs. A caller arriving while one of these is in flight is
     * replayed against a fresh sweep as before, so a handed-in inventory is
     * only ever used by the call that loaded it.
     */
    discoverAsync(onDone, inventory) {
        if (this._destroyed)
            return;
        if (this._discovering) {
            /* This caller arrived after the current inventory began. Its
             * promise belongs to the replay that observes everything up to
             * this request, not to the older snapshot already in flight. */
            if (onDone)
                this._discoverNextWaiters.push(onDone);
            this._discoverAgain = true;
            return;
        }
        if (onDone)
            this._discoverWaiters.push(onDone);
        this._discovering = true;
        let adopt = snapshot => {
            if (this._destroyed)
                return;
            this._discovering = false;
            this._adopt(snapshot.sensors, snapshot.counters, snapshot.topology,
                        snapshot.directPowers);
            let waiters = this._discoverWaiters.splice(0);
            for (let waiter of waiters)
                waiter(true);
            this._onChanged();

            if (this._discoverAgain) {
                this._discoverAgain = false;
                this._discoverWaiters = this._discoverNextWaiters.splice(0);
                this.discoverAsync();
            } else {
                /* A refresh requested during discovery checks the completed
                 * snapshot instead of queuing another complete sweep before
                 * that snapshot has even established its topology. */
                this._refresh.resume();
            }
        };
        if (inventory)
            snapshotFromInventoryAsync(inventory, adopt, this._io);
        else
            discoverSnapshotAsync(adopt, this._io);
    }

    _adopt(found, counters, topology, directPowers) {
        /* One assignment boundary: a reading sees the complete old machine or
         * the complete new one, never half of each. */
        this.temperatureSensors = found.temperatures;
        this.fanSensors = found.fans;
        this.powerSensors = found.powerMeters.concat(directPowers || []);
        /* The meters keep the previous counter value between polls, so they
         * outlive a reading and are only rebuilt by a rediscovery. */
        this.energyMeters = counters.map(counter => new EnergyMeter(counter));
        this._topology = topology;
    }

    /*
     * A cheap description of what is present: the three roots, one shallow
     * listing per hwmon and thermal device, and access metadata for the few
     * powercap counters. This catches both whole devices and sensor channels
     * moving inside an existing device; installing the optional RAPL rule
     * changes the access metadata.
     */
    _topologyKey() {
        let directories = _directoryInventory();
        return _topologyFromInventory(directories, IO.readString, IO.readLink, IO.canRead);
    }

    /*
     * Checks for hardware that has come or gone, and sweeps again only if
     * there is any. Both modes answer the caller: synchronous sets return
     * whether they swept and call onDone with the same answer, asynchronous
     * sets return that the request was accepted and answer onDone when the
     * check lands. The callback used to be dropped on the synchronous branch,
     * so one of the two contracts silently left its caller waiting.
     *
     * The comparison includes the stable metadata and device links that give
     * those nodes meaning. Moving readings are excluded.
     */
    refresh(onDone) {
        if (this._destroyed)
            return false;
        if (!this._asynchronous) {
            let swept = this._topologyKey() !== this._topology;
            if (swept)
                this.discover();
            if (onDone)
                onDone(swept);
            return swept;
        }

        /* The inventory in flight may have begun before this request, so one
         * later check covers every overlapping caller; see lib/refresh.js. */
        return this._refresh.request(onDone);
    }

    /* One shallow walk of the three roots, and a full sweep only where it
     * shows the machine has changed. */
    _sweep(done) {
        _loadInventoryAsync(inventory => {
            if (this._destroyed)
                return;
            if (_inventoryTopology(inventory) === this._topology) {
                done(false);
                return;
            }
            /* The machine changed, and this sweep already holds everything
             * the snapshot is built from. */
            this.discoverAsync(() => done(true), inventory);
        }, this._io);
    }

    /* Every caller accepted before teardown is answered once, unsuccessfully:
     * cancelled I/O may never reach its ordinary completion. The first throw
     * is handed back rather than swallowed or allowed to strand the rest. */
    destroy() {
        if (this._destroyed)
            return null;
        this._destroyed = true;
        this._onChanged = function () {};
        this._discovering = false;
        this._discoverAgain = false;
        let waiters = this._discoverWaiters.splice(0)
            .concat(this._discoverNextWaiters.splice(0));
        let firstError = null;
        for (let waiter of waiters) {
            try {
                waiter(false);
            } catch (error) {
                firstError = firstError || error;
            }
        }
        /* After the discoveries, in the order they were accepted in: a
         * topology check is asked for behind a discovery, never in front of
         * one. */
        firstError = firstError || this._refresh.stop();
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        return firstError;
    }
};

/*
 * What a set of discovered sensors reads, given the numbers behind them.
 *
 * A function of an inventory and a way of getting a value: hand it the same
 * lists and the same values and it says the same thing, whether those values
 * came one file read at a time or out of a batch that was loaded off the main
 * loop. That is why read() and readAsync() cannot drift - there is one
 * assembly and two sources for it.
 *
 * The one thing it remembers is which unlabelled fans have been seen turning,
 * which is a judgement about the hardware rather than about this reading: a
 * fan that has spun once is wired, and stays wired after it stops.
 */
const SensorReader = class SensorReader {
    /* `lists` answers the current inventory as { temperatures, fans, meters,
     * powers }. */
    constructor(lists) {
        this._lists = lists || (() => ({ temperatures: [], fans: [], meters: [], powers: [] }));
        /* Held here rather than on the discovered records because a
         * rediscovery replaces those wholesale, which would drop a fan that
         * has spun and since stopped out of the menu. */
        this._fansThatHaveRun = new Set();
    }

    temperature(sensor, readNumber) {
        let fault = sensor.faultPath ? readNumber(sensor.faultPath) : 0;
        let raw = fault !== null && fault > 0 ? null : readNumber(sensor.path);
        return {
            id: sensor.id,
            measure: sensor.measure,
            chip: sensor.chip,
            /* what the driver calls it, which is what anything picking a
             * sensor by name has to match on */
            rawLabel: sensor.rawLabel,
            kind: sensor.kind,
            label: Format.sensorLabel(sensor),
            /* what the chip is called, and what this reading is called under
             * that heading; see _groupName and _shortName */
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            shortLabel: sensor.short,
            critical: sensor.critical,
            celsius: raw === null ? null : raw / 1000,
        };
    }

    _selectTemperatures(keep, sensors) {
        let fallbackDevices = new Set();
        for (let sensor of sensors) {
            if (sensor.fallbackForDevice && keep(sensor))
                fallbackDevices.add(sensor.fallbackForDevice);
        }
        let primary = sensors.filter(sensor => !sensor.fallbackForDevice &&
            (keep(sensor) || (sensor.deviceIdentity &&
                              fallbackDevices.has(sensor.deviceIdentity))));
        let primaryDevices = new Set(primary
            .map(sensor => sensor.deviceIdentity)
            .filter(device => !!device));
        let fallbacks = sensors.filter(sensor => sensor.fallbackForDevice &&
            (keep(sensor) || primaryDevices.has(sensor.fallbackForDevice)));
        return { primary: primary, fallbacks: fallbacks };
    }

    temperatures(keep, readNumber, lists) {
        let found = lists || this._lists();
        let selected = this._selectTemperatures(keep, found.temperatures);
        let readings = selected.primary.map(sensor => ({
            sensor: sensor,
            reading: this.temperature(sensor, readNumber),
        }));
        let validDevices = new Set(readings
            .filter(item => item.reading.celsius !== null && item.sensor.deviceIdentity)
            .map(item => item.sensor.deviceIdentity));
        let result = readings.map(item => item.reading);
        for (let sensor of selected.fallbacks) {
            if (!validDevices.has(sensor.fallbackForDevice))
                result.push(this.temperature(sensor, readNumber));
        }
        return result;
    }

    fan(sensor, readNumber) {
        let fault = sensor.faultPath ? readNumber(sensor.faultPath) : 0;
        let rpm = fault !== null && fault > 0 ? null : readNumber(sensor.path);
        if (rpm !== null && rpm > 0)
            this._fansThatHaveRun.add(sensor.id);
        return {
            id: sensor.id,
            measure: sensor.measure,
            chip: sensor.chip,
            rawLabel: sensor.rawLabel,
            kind: sensor.kind,
            label: Format.sensorLabel(sensor),
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            shortLabel: sensor.short,
            /* A label is the driver's declaration that this input is wired.
             * An unlabelled input earns the same status after it has produced
             * a non-zero reading, and keeps it when the fan later stops. */
            inUse: !!sensor.rawLabel || this._fansThatHaveRun.has(sensor.id),
            rpm: rpm,
        };
    }

    powers(keep, readNumber, lists) {
        let found = lists || this._lists();
        let readings = [];
        let packageWatts = null;

        for (let meter of found.meters) {
            if (!keep(meter))
                continue;
            meter.sample(undefined, readNumber);
            if (meter.watts === null)
                continue;
            readings.push({
                id: meter.id,
                measure: meter.measure,
                kind: meter.kind,
                label: meter.label,
                group: meter.group,
                groupLabel: Kinds.kindLabel(meter.kind),
                shortLabel: meter.label,
                watts: meter.watts,
            });
            /* The sub-domains are inside the top level ones, so adding both
             * would count the same joules twice. */
            if (meter.topLevel)
                packageWatts = (packageWatts || 0) + meter.watts;
        }

        for (let sensor of found.powers) {
            if (!keep(sensor))
                continue;
            let raw = readNumber(sensor.path);
            if (raw === null && sensor.fallbackPath)
                raw = readNumber(sensor.fallbackPath);
            if (raw === null)
                continue;
            readings.push({
                id: sensor.id,
                measure: sensor.measure,
                kind: sensor.kind,
                label: Format.sensorLabel(sensor),
                group: sensor.group,
                groupLabel: sensor.groupLabel,
                shortLabel: sensor.short,
                /* Only this kind of channel may be aggregated across devices;
                 * discovery leaves ambiguous rails false. */
                deviceTotal: !!sensor.deviceTotal,
                /* A DTPM root is the aggregate for the platform subtree. */
                platformTotal: !!sensor.platformTotal,
                /* hwmon reports microwatts */
                watts: raw / 1000000,
            });
        }

        return { readings: readings, packageWatts: packageWatts };
    }

    _appendPaths(paths, sensors, keep, secondary) {
        for (let sensor of sensors) {
            if (!keep(sensor))
                continue;
            paths.push(sensor.path);
            if (secondary && sensor[secondary])
                paths.push(sensor[secondary]);
        }
    }

    /* Every node one reading touches, for whoever wants to load them first. */
    paths(keep, lists) {
        let found = lists || this._lists();
        let paths = [];
        let temperatures = this._selectTemperatures(keep, found.temperatures);
        this._appendPaths(paths, temperatures.primary.concat(temperatures.fallbacks),
                          () => true, "faultPath");
        this._appendPaths(paths, found.fans, keep, "faultPath");
        for (let meter of found.meters)
            if (keep(meter))
                paths.push(meter.counter.path);
        this._appendPaths(paths, found.powers, keep, "fallbackPath");
        return paths;
    }

    assemble(keep, readNumber, lists) {
        let found = lists || this._lists();
        let powers = this.powers(keep, readNumber, found);
        return {
            temperatures: this.temperatures(keep, readNumber, found),
            fans: found.fans.filter(keep).map(sensor => this.fan(sensor, readNumber)),
            powers: powers.readings,
            packageWatts: powers.packageWatts,
        };
    }

};

/*
 * The sensors of one machine: what was found, and what they read now.
 *
 * Two objects underneath - an inventory that knows what is there, and a
 * reader that turns values into readings - and one filesystem scope, which is
 * what a poll's batch and a discovery sweep both hang off and what teardown
 * cancels.
 */
const SensorSet = class SensorSet {
    constructor(options) {
        let configuration = options || {};
        this._destroyed = false;
        this._ioScope = new IO.AsyncScope();
        this._ioOptions = { scope: this._ioScope };
        this._inventory = new SensorInventory({
            asynchronous: configuration.asynchronous,
            onChanged: configuration.onChanged,
            io: this._ioOptions,
        });
        this._reader = new SensorReader(() => this._inventory.lists());
        this._inventory.start();
    }

    get temperatureSensors() {
        return this._inventory.temperatureSensors;
    }

    get fanSensors() {
        return this._inventory.fanSensors;
    }

    get powerSensors() {
        return this._inventory.powerSensors;
    }

    get energyMeters() {
        return this._inventory.energyMeters;
    }

    discover() {
        this._inventory.discover();
    }

    discoverAsync(onDone, inventory) {
        this._inventory.discoverAsync(onDone, inventory);
    }

    refresh(onDone) {
        return this._inventory.refresh(onDone);
    }

    /* What was discovered, as one thing that can be held on to. */
    _lists() {
        return this._inventory.lists();
    }

    /*
     * One value per sensor, as of now - but only for the sensors `wanted`
     * says yes to.
     *
     * That filter is not an optimisation detail, it is most of the cost of a
     * poll. Reading a disk temperature wakes the drive: on the machine this
     * was written on, nvme and drivetemp nodes take between 0.1 and 1.6
     * milliseconds each while every other sensor takes about 50 microseconds,
     * and those are exactly the ones the menu hides by default. Reading them
     * anyway meant spending nine tenths of every poll on numbers that were
     * then filtered out.
     *
     * Without a filter everything is read, which is what discovery-only
     * callers want.
     */
    read(wanted) {
        let keep = wanted || (() => true);
        return this._reader.assemble(keep, IO.readNumber);
    }

    /*
     * The same reading, without holding up the caller.
     *
     * Every node the reading will touch is loaded first, all at once and off
     * the main loop, and then the reading is assembled out of what came back.
     * That is the whole difference: read() and readAsync() share one assembly,
     * so a value can only be understood one way, and what changes is where the
     * bytes came from.
     *
     * It matters because a sysfs read is not reliably quick. On the machine
     * this was written on, reading every sensor takes about a tenth of a
     * millisecond each for the chips that are awake and tens of milliseconds
     * in total once the disks are included, because reading a drive's
     * temperature wakes the drive. Synchronously, in the process that draws
     * the desktop, that is several dropped frames every poll.
     *
     * The energy meters take their elapsed time when the reading is assembled
     * rather than when the counter was read. Those are a few milliseconds
     * apart against an interval of seconds, which the watts figure does not
     * notice.
     */
    readAsync(wanted, onDone) {
        if (this._destroyed)
            return;
        let keep = wanted || (() => true);
        /*
         * The lists are taken now, not when the answer comes back.
         *
         * A rediscovery can land in between - the poll asks for one every
         * minute, opening the menu asks for one every time - and it replaces
         * every list on this object. The paths were collected before the read
         * and the reading used to be assembled out of whatever the lists held
         * afterwards, so a sweep in the middle meant looking up new sensors in
         * an answer keyed by the old ones: every value missing, and one poll
         * where the whole machine read null.
         *
         * Both callers refresh before they update, so it takes the two to slip
         * past each other - an update deferred by an in-flight read finishing
         * after the next tick's sweep. Rare, and it costs one array of
         * references to make impossible.
        */
        let found = this._lists();
        let finish = Once.once(answer => onDone(answer));
        IO.readStringsAsync(this._reader.paths(keep, found), values => {
            if (this._destroyed) {
                finish(null);
                return;
            }
            finish(this._reader.assemble(keep, path => IO.toNumber(values[path]), found));
        }, 32, null, this._ioOptions);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._ioScope.cancel();
        let firstError = this._inventory.destroy();
        if (firstError)
            throw firstError;
    }
};
