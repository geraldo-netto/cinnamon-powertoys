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
const Translate = require("./lib/gettext.js");

const _ = Translate._;

var HWMON_DIR = "/sys/class/hwmon";
var THERMAL_DIR = "/sys/class/thermal";
var POWERCAP_DIR = "/sys/class/powercap";

/*
 * What a sensor can be, said once.
 *
 * Each kind carries everything anyone needs to know about it: the chip name
 * prefixes that select it, the name it is shown under, whether it is worth
 * listing when the menu is not asked for every sensor on the machine, and -
 * as the position in this array - where it sorts. Keeping those apart is how
 * "package" came to exist in the sort order and nowhere else.
 *
 * The order is the display order, and a chip is classified by the first
 * pattern that matches it, so a more specific kind has to come first. The two
 * kinds without a pattern are never guessed from a chip name: "package" is
 * what the powercap counters report, "other" is what is left.
 */
var KINDS = [
    { kind: "cpu",     primary: true,  label: _("Processor"),
      pattern: /^(k10temp|zenpower|coretemp|cpu_thermal|cpu-thermal|x86_pkg_temp|soc_thermal|cpu\d*_thermal)/i },
    { kind: "gpu",     primary: true,  label: _("Graphics"),
      pattern: /^(amdgpu|radeon|nouveau|nvidia|i915|xe|gpu_thermal|gpu-thermal)/i },
    { kind: "package", primary: true,  label: _("Package"),   pattern: null },
    { kind: "battery", primary: true,  label: _("Battery"),
      pattern: /^(bat\d*|bq\d|max\d{4}|rt\d{4})/i },
    { kind: "board",   primary: false, label: _("Mainboard"),
      pattern: /^(acpitz|pch_|nct\d|it87|thinkpad|asus|dell_smm|gigabyte|corsair)/i },
    { kind: "disk",    primary: false, label: _("Storage"),
      pattern: /^(nvme|drivetemp)/i },
    { kind: "network", primary: false, label: _("Network"),
      pattern: /^(iwlwifi|ath\d*k|mt79|mt76|rtw|brcm|r8\d{3}|igb|igc|e1000|ixgbe)/i },
    { kind: "other",   primary: false, label: _("Other"),     pattern: null },
];

function _kind(name) {
    return KINDS.find(entry => entry.kind === name) || null;
}

function classifyChip(name) {
    for (let entry of KINDS) {
        if (entry.pattern && entry.pattern.test(name))
            return entry.kind;
    }
    return "other";
}

function kindLabel(kind) {
    let entry = _kind(kind);
    return entry ? entry.label : _kind("other").label;
}

/* Whether the kind survives the "only the interesting ones" menu filter. */
function isPrimaryKind(kind) {
    let entry = _kind(kind);
    return entry ? entry.primary : false;
}

/* Sort position; anything unrecognised goes last. */
function kindRank(kind) {
    let index = KINDS.findIndex(entry => entry.kind === kind);
    return index < 0 ? KINDS.length : index;
}

/*
 * Whether a sensor answers to a name, judged on what the kernel calls it.
 *
 * Deliberately not the menu name: that one is composed for reading - the chip
 * prefixed, a disambiguating suffix appended - and changing how it is built
 * would silently change which sensor anything matching on it picks. These are
 * the driver's own words, and a thermal zone that has no label of its own is
 * matched on its type.
 */
function sensorMatches(sensor, fragment) {
    if (!fragment)
        return false;
    let wanted = fragment.toLowerCase();
    return (sensor.rawLabel || "").toLowerCase().indexOf(wanted) >= 0 ||
           (sensor.chip || "").toLowerCase().indexOf(wanted) >= 0;
}

/*
 * Everything one chip has to say, together.
 *
 * Kind first, so the processor's readings are in one place and the graphics
 * card's in another; then temperature, fan, power within a kind, because that
 * is the order of interest; then by name. Sorting the three measures
 * separately would have put a card's fan speed several rows below its
 * temperature with another chip's readings in between.
 *
 * A reading with no measure - which is anything sorted before the three lists
 * are joined - falls through to the name, which is what this did before the
 * measure was part of it.
 */
const MEASURE_ORDER = ["temperature", "fan", "power"];

function bySensorOrder(a, b) {
    let byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind !== 0)
        return byKind;
    /*
     * Then by which chip it came off, so that two graphics cards are two
     * blocks rather than one interleaved list. Natural order, so hwmon9 comes
     * before hwmon10 and the discrete card - which the kernel numbers first -
     * stays above the one in the processor.
     */
    let byGroup = IO.naturalCompare(a.group || "", b.group || "");
    if (byGroup !== 0)
        return byGroup;
    let byMeasure = MEASURE_ORDER.indexOf(a.measure) - MEASURE_ORDER.indexOf(b.measure);
    if (byMeasure !== 0)
        return byMeasure;
    if (a.label === b.label)
        return 0;
    return a.label < b.label ? -1 : 1;
}

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
 * What a sensor is called under a heading that already names the chip.
 *
 * "amdgpu edge" is two words of which one is the heading, so the chip comes
 * off. What is left is the driver's own word for the reading, which is a word
 * to whoever wrote the driver and a riddle to everyone else. The ones below
 * are spelled out; everything else is passed through with a capital on it,
 * because guessing at a name is worse than showing the one the kernel uses.
 *
 * A reading the driver never labelled is named after what it measures, which
 * under the chip's own heading is all there is left to say about it.
 *
 * The processor's three keep the driver's word in brackets after the spelled
 * out one. It is the string the preferred-sensor setting is matched against,
 * and this row is the only place in the applet it is ever written, so a name
 * that replaced it would leave nothing to copy into that box.
 *
 * What they mean is the kernel's. From Documentation/hwmon/k10temp.rst: Tctl
 * is "the processor temperature control value, used by the platform to
 * control cooling systems", on an arbitrary scale rather than a physical one;
 * Tdie is the temperature actually measured; Tccd1..8 are the Core Complex
 * Dies, the chiplets the cores sit on.
 *
 * From amdgpu, where the labels are a table in amdgpu_pm.c and each entry is
 * read in amdgpu_hwmon_show_temp: "junction" asks the card for
 * AMDGPU_PP_SENSOR_HOTSPOT_TEMP, so it is the hotspot, which is the name the
 * rest of the world uses for it; "edge" asks for AMDGPU_PP_SENSOR_EDGE_TEMP,
 * away from that hotspot; "mem" is the memory on the card. vddnb is the one
 * the driver refuses on anything but an APU - "only APUs have vddnb" - and it
 * is that chip's SoC rail.
 *
 * Each entry answers with the name rather than being a replacement string.
 * These are translated, and a replacement string is not text: `$&`, `$1` and
 * `$'` are substitutions to String.replace, so a translator who wrote a `$`
 * got it eaten or got part of the label repeated back at them. The entries
 * that quote the driver back ask the match for it instead, which also keeps
 * the driver's own capitals.
 */
const SHORT_LABELS = [
    [/^tccd(\d+)$/i, match => Translate.interpolate(
        _("Core die %{number} (%{token})"), { number: match[1], token: match[0] })],
    [/^tccd$/i, match => Translate.interpolate(
        _("Core die (%{token})"), { token: match[0] })],
    [/^tdie$/i, match => Translate.interpolate(
        _("Measured die (%{token})"), { token: match[0] })],
    [/^tctl$/i, match => Translate.interpolate(
        _("Cooling control (%{token})"), { token: match[0] })],
    [/^edge$/i, () => _("Die edge")],
    [/^junction$/i, () => _("Hotspot")],
    [/^mem$/i, () => _("Memory")],
    [/^vddgfx$/i, () => _("Core voltage")],
    [/^vddnb$/i, () => _("SoC voltage")],
    [/^ppt$/i, () => _("Power")],
];

function _shortName(entry) {
    let label = entry.rawLabel;
    if (!label) {
        let measure = Format.measureName(entry.measure) || entry.chip;
        return entry.siblings > 1 ? measure + " " + entry.index : measure;
    }

    if (label.toLowerCase().indexOf(entry.chip.toLowerCase()) === 0)
        label = label.slice(entry.chip.length).trim() || label;

    for (let [pattern, name] of SHORT_LABELS) {
        let match = pattern.exec(label);
        if (match)
            return name(match);
    }
    return Format.capitalize(label);
}

/* "k10temp Tctl" rather than "Tctl", and "drivetemp 1" where a chip has
 * several of something and names none of them. */
function _displayName(entry) {
    let chip = entry.chip;
    let label = entry.rawLabel;
    if (!label)
        return entry.siblings > 1 ? chip + " " + entry.index : chip;
    if (label.toLowerCase().indexOf(chip.toLowerCase()) === 0)
        return label;
    return chip + " " + label;
}

/*
 * Names everything discovered, in one pass, without touching what it was
 * given: an entry comes back as a copy carrying `display`.
 *
 * Where that name would be ambiguous - five drivetemp chips all called
 * "drivetemp" - whatever tells them apart is appended: the block device, the
 * PCI slot, the thermal zone.
 *
 * Ambiguity is judged within a measure and not across all of them. Two
 * readings from one card, a fan and a power meter, are both "amdgpu", and
 * appending the same PCI slot to each would leave them just as alike and
 * longer; they are already told apart by being in RPM and in watts.
 */
function _finalizeNames(entries) {
    let named = entries.map(entry => Object.assign({}, entry, {
        display: _displayName(entry),
        short: _shortName(entry),
    }));

    let counts = {};
    for (let entry of named) {
        let key = entry.measure + "\u0000" + entry.display;
        counts[key] = (counts[key] || 0) + 1;
    }

    return named.map(function (entry) {
        let key = entry.measure + "\u0000" + entry.display;
        if (counts[key] > 1 && entry.identity)
            return Object.assign({}, entry, { display: entry.display + " (" + entry.identity + ")" });
        return entry;
    });
}

/*
 * What the chip a reading came off is called, in the words somebody would use
 * for it.
 *
 * The kernel identifies a chip by its driver and its address - "amdgpu" at
 * 03:00.0 - and neither says which of the two cards in the machine it is. The
 * processor is named from /proc/cpuinfo and anything on the PCI bus from
 * pci.ids; a chip that is on neither keeps the driver's own name, which is at
 * least the name its documentation uses.
 *
 * The address is still the answer when there is no table to look it up in,
 * because a name that cannot be found is not a reason to show nothing.
 */
function _groupName(entry, pciNames, cpuName) {
    if (entry.kind === "cpu" && cpuName)
        return cpuName;
    if (entry.pciAddress && pciNames[entry.pciAddress])
        return pciNames[entry.pciAddress];
    return entry.chip;
}

/*
 * Names every group, and tells apart the ones that came out alike.
 *
 * Two identical cards resolve to one name, and two headings reading "Radeon RX
 * 6600" over different numbers is worse than no heading at all, so whatever
 * told the chips apart in the first place is appended - the PCI slot, the
 * block device, the thermal zone.
 */
function _nameGroupsFrom(groups, cpuName, pciNames) {
    let named = groups.map(group => Object.assign({}, group, {
        label: _groupName(group, pciNames, cpuName),
    }));

    let counts = {};
    for (let group of named)
        counts[group.label] = (counts[group.label] || 0) + 1;

    let labels = {};
    for (let group of named) {
        labels[group.key] = counts[group.label] > 1 && group.identity
            ? group.label + " (" + group.identity + ")"
            : group.label;
    }
    return labels;
}

function _nameGroups(groups) {
    return _nameGroupsFrom(groups, Hardware.cpuModelName(),
                           Hardware.pciDeviceNames(groups.map(group => group.pciAddress)));
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

function _metadataPaths(directories) {
    let paths = [];
    let list = path => directories[path] || [];
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
    for (let entry of list(POWERCAP_DIR)) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        paths.push(base + "/energy_uj", base + "/power_uw", base + "/name",
                   base + "/max_energy_range_uj");
    }
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

function _scanSensors(directories, readString, readLink) {
    let found = { temperatures: [], fans: [], powerMeters: [] };
    let hwmonTemperatureDevices = new Set();
    let groups = [];
    let list = path => directories[path] || [];
    let link = readLink || IO.readLink;
    let readNumber = path => IO.toNumber(readString(path));
    let exists = path => {
        let parent = GLib.path_get_dirname(path);
        return list(parent).indexOf(GLib.path_get_basename(path)) >= 0;
    };

    for (let entry of list(HWMON_DIR)) {
        let base = HWMON_DIR + "/" + entry;
        let chip = readString(base + "/name") || entry;
        let kind = classifyChip(chip);
        let identity = _hwmonIdentity(base, list, link);
        let device = deviceIdentity(base, link);
        let pciAddress = Hardware.pciAddressIn(link(base + "/device"));
        let group = "hwmon:" + entry;
        groups.push({ key: group, chip: chip, kind: kind, identity: identity,
                      pciAddress: pciAddress });

        let ofThisChip = { temperatures: [], fans: [], powerMeters: [] };

        for (let node of list(base)) {
            for (let nodeKind of NODE_KINDS) {
                let match = node.match(nodeKind.pattern);
                if (!match)
                    continue;

                let index = match[1];
                if (nodeKind.skip && nodeKind.skip(base, index, match, exists))
                    break;

                let sensor = {
                    id: "hwmon:" + entry + ":" + nodeKind.prefix + index,
                    measure: nodeKind.measure,
                    source: "hwmon",
                    chip: chip,
                    kind: kind,
                    group: group,
                    index: index,
                    identity: identity,
                    deviceIdentity: device,
                    rawLabel: _label(base, nodeKind.prefix, index, readString),
                    path: base + "/" + node,
                };
                if (nodeKind.prefix === "power" && match[2] === "average") {
                    let input = base + "/power" + index + "_input";
                    sensor.fallbackPath = exists(input) ? input : null;
                }
                let faultPath = base + "/" + nodeKind.prefix + index + "_fault";
                sensor.faultPath = nodeKind.fault && exists(faultPath) ? faultPath : null;
                if (nodeKind.extra)
                    Object.assign(sensor, nodeKind.extra(base, index, readNumber));

                ofThisChip[nodeKind.list].push(sensor);
                break;
            }
        }

        if (kind === "gpu") {
            let total = gpuDeviceTotal(ofThisChip.powerMeters);
            for (let meter of ofThisChip.powerMeters)
                meter.deviceTotal = meter === total;
        }

        /* How many of its own kind this chip has, which decides whether an
         * unlabelled sensor needs its index in the name. */
        for (let list in ofThisChip) {
            for (let sensor of ofThisChip[list])
                sensor.siblings = ofThisChip[list].length;
            found[list] = found[list].concat(ofThisChip[list]);
        }
        if (device && ofThisChip.temperatures.length > 0)
            hwmonTemperatureDevices.add(device);
    }

    for (let entry of list(THERMAL_DIR)) {
        if (!/^thermal_zone\d+$/.test(entry))
            continue;
        let base = THERMAL_DIR + "/" + entry;
        let type = readString(base + "/type");
        let device = deviceIdentity(base, link);
        if (!type)
            continue;
        groups.push({ key: "thermal:" + entry, chip: type, kind: classifyChip(type),
                      identity: entry, pciAddress: null });
        found.temperatures.push({
            id: "thermal:" + entry,
            measure: "temperature",
            source: "thermal",
            chip: type,
            kind: classifyChip(type),
            group: "thermal:" + entry,
            index: "1",
            siblings: 1,
            identity: entry,
            deviceIdentity: device,
            fallbackForDevice: device && hwmonTemperatureDevices.has(device)
                ? device : null,
            rawLabel: null,
            path: base + "/temp",
            critical: _criticalTripPoint(base, list, readString),
        });
    }

    return { found: found, groups: groups };
}

function _finishSensors(scanned, groupLabels) {
    let found = scanned.found;
    /* One pass over everything, then split back out by what it measures. */
    let named = _finalizeNames(found.temperatures.concat(found.fans, found.powerMeters))
        .map(entry => Object.assign({}, entry, { groupLabel: groupLabels[entry.group] || "" }));
    return {
        temperatures: named.filter(entry => entry.measure === "temperature"),
        fans: named.filter(entry => entry.measure === "fan"),
        powerMeters: named.filter(entry => entry.measure === "power"),
    };
}

function discoverSensors() {
    let directories = _directoryInventory();
    let scanned = _scanSensors(directories, IO.readString);
    return _finishSensors(scanned, _nameGroups(scanned.groups));
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
        if (/^dtpm/.test(entry) && readable(base + "/power_uw"))
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

/* The refresh check follows the same asynchronous directory, metadata and
 * link route as discovery. Values that move on every reading are excluded;
 * everything retained is something discovery uses to classify or name a
 * sensor. Nothing here blocks Cinnamon's main thread. */
function topologyKeyAsync(onDone, ioOptions) {
    _directoryInventoryAsync(directories => {
        let metadata = null;
        let links = null;
        let access = null;
        let finish = () => {
            if (metadata === null || links === null || access === null)
                return;
            let read = path => metadata[path] === undefined ? null : metadata[path];
            let readLink = path => links[path] === undefined ? null : links[path];
            let readable = path => access[path] === true;
            onDone(_topologyFromInventory(directories, read, readLink, readable));
        };
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

/* One complete sensor snapshot, assembled only after every asynchronous part
 * has answered. Until this callback, callers keep using the prior snapshot. */
function discoverSnapshotAsync(onDone, ioOptions) {
    _directoryInventoryAsync(directories => {
        let metadata = null;
        let links = null;
        let access = null;
        let finish = () => {
            if (metadata === null || links === null || access === null)
                return;
            let values = metadata;
            let read = path => values[path] === undefined ? null : values[path];
            let readLink = path => links[path] === undefined ? null : links[path];
            let readable = path => access[path] === true;
            let scanned = _scanSensors(directories, read, readLink);
            let addresses = scanned.groups.map(group => group.pciAddress);
            Hardware.machineNamesAsync(addresses, names => {
                let labels = _nameGroupsFrom(scanned.groups, names.cpuName, names.pciNames);
                onDone({
                    sensors: _finishSensors(scanned, labels),
                    counters: _energyCounters(
                        directories[POWERCAP_DIR] || [], read, readable),
                    directPowers: _directPowercapSensors(
                        directories[POWERCAP_DIR] || [], read, readable),
                    topology: _topologyFromInventory(directories, read, readLink, readable),
                });
            }, ioOptions);
        };
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

function discoverSensorsAsync(onDone, ioOptions) {
    discoverSnapshotAsync(snapshot => onDone(snapshot.sensors), ioOptions);
}

/* Turns a monotonic microjoule counter into watts. */
var EnergyMeter = class EnergyMeter {
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
 * The sensors of one machine: what was found, and what they read now.
 *
 * Discovery is the expensive half - every hwmon directory listed, every label
 * file opened - and it only changes when hardware does, so it happens once
 * and the result is kept. read() is the cheap half, one file per sensor, and
 * is what a poll calls.
 */
var SensorSet = class SensorSet {
    constructor(options) {
        let configuration = options || {};
        this._topology = null;
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        this._asynchronous = !!configuration.asynchronous;
        this._onChanged = configuration.onChanged || function () {};
        this._discovering = false;
        this._discoverAgain = false;
        this._discoverWaiters = [];
        this._discoverNextWaiters = [];
        this._refreshing = false;
        this._refreshPending = false;
        this._refreshChanged = false;
        this._refreshWaiters = [];
        this._destroyed = false;
        this._ioScope = new IO.AsyncScope();
        this._ioOptions = { scope: this._ioScope };

        if (this._asynchronous)
            this.discoverAsync();
        else
            this.discover();
    }

    discover() {
        if (this._destroyed)
            return;
        let found = discoverSensors();
        this._adopt(found, discoverEnergyCounters(), this._topologyKey(),
                    discoverDirectPowercapSensors());
    }

    discoverAsync(onDone) {
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
        discoverSnapshotAsync(snapshot => {
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
            } else if (this._refreshPending && !this._refreshing) {
                /* A refresh requested during discovery checks the completed
                 * snapshot instead of queuing another complete sweep before
                 * that snapshot has even established its topology. */
                this._refreshPending = false;
                this._startRefresh();
            }
        }, this._ioOptions);
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
     * there is any. Synchronous sets answer whether they swept; asynchronous
     * sets take an optional callback with that answer and report that the
     * request was accepted immediately.
     *
     * The comparison includes the stable metadata and device links that give
     * those nodes meaning. Moving readings are excluded.
     */
    refresh(onDone) {
        if (this._destroyed)
            return false;
        if (!this._asynchronous) {
            if (this._topologyKey() === this._topology)
                return false;
            this.discover();
            return true;
        }

        if (onDone)
            this._refreshWaiters.push(onDone);
        if (this._refreshing) {
            /* The inventory in flight may have begun before this request.
             * One later check is enough to cover every overlapping caller. */
            this._refreshPending = true;
            return true;
        }
        if (this._discovering) {
            this._refreshPending = true;
            return true;
        }
        this._startRefresh();
        return true;
    }

    _startRefresh() {
        if (this._destroyed)
            return;
        this._refreshing = true;
        topologyKeyAsync(topology => {
            if (this._destroyed)
                return;
            if (topology === this._topology) {
                this._finishRefresh(false);
                return;
            }
            this.discoverAsync(() => this._finishRefresh(true));
        }, this._ioOptions);
    }

    _finishRefresh(changed) {
        if (this._destroyed)
            return;
        this._refreshChanged = this._refreshChanged || changed;
        if (this._refreshPending) {
            this._refreshPending = false;
            this._startRefresh();
            return;
        }
        this._refreshing = false;
        let result = this._refreshChanged;
        this._refreshChanged = false;
        let waiters = this._refreshWaiters.splice(0);
        for (let waiter of waiters)
            waiter(result);
    }

    _temperature(sensor, readNumber) {
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

    _temperatureSelection(keep, sensors) {
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

    _temperatures(keep, readNumber, lists) {
        let found = lists || this._lists();
        let selected = this._temperatureSelection(keep, found.temperatures);
        let readings = selected.primary.map(sensor => ({
            sensor: sensor,
            reading: this._temperature(sensor, readNumber),
        }));
        let validDevices = new Set(readings
            .filter(item => item.reading.celsius !== null && item.sensor.deviceIdentity)
            .map(item => item.sensor.deviceIdentity));
        let result = readings.map(item => item.reading);
        for (let sensor of selected.fallbacks) {
            if (!validDevices.has(sensor.fallbackForDevice))
                result.push(this._temperature(sensor, readNumber));
        }
        return result;
    }

    _fan(sensor, readNumber) {
        let fault = sensor.faultPath ? readNumber(sensor.faultPath) : 0;
        let rpm = fault !== null && fault > 0 ? null : readNumber(sensor.path);
        if (rpm !== null && rpm > 0)
            sensor.hasRun = true;
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
            inUse: !!sensor.rawLabel || !!sensor.hasRun,
            rpm: rpm,
        };
    }

    _powers(keep, readNumber, lists) {
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
                groupLabel: kindLabel(meter.kind),
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
        return this._assemble(keep, IO.readNumber);
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
        let finished = false;
        let finish = answer => {
            if (finished)
                return;
            finished = true;
            onDone(answer);
        };
        IO.readStringsAsync(this._paths(keep, found), values => {
            if (this._destroyed) {
                finish(null);
                return;
            }
            finish(this._assemble(keep, path => IO.toNumber(values[path]), found));
        }, 32, null, this._ioOptions);
    }

    /* What was discovered, as one thing that can be held on to. */
    _lists() {
        return {
            temperatures: this.temperatureSensors,
            fans: this.fanSensors,
            meters: this.energyMeters,
            powers: this.powerSensors,
        };
    }

    /* Every node one reading touches, for whoever wants to load them first. */
    _paths(keep, lists) {
        let found = lists || this._lists();
        let paths = [];
        let temperatures = this._temperatureSelection(keep, found.temperatures);
        for (let sensor of temperatures.primary.concat(temperatures.fallbacks)) {
            paths.push(sensor.path);
            if (sensor.faultPath)
                paths.push(sensor.faultPath);
        }
        for (let sensor of found.fans)
            if (keep(sensor)) {
                paths.push(sensor.path);
                if (sensor.faultPath)
                    paths.push(sensor.faultPath);
            }
        for (let meter of found.meters)
            if (keep(meter))
                paths.push(meter.counter.path);
        for (let sensor of found.powers)
            if (keep(sensor)) {
                paths.push(sensor.path);
                if (sensor.fallbackPath)
                    paths.push(sensor.fallbackPath);
            }
        return paths;
    }

    _assemble(keep, readNumber, lists) {
        let found = lists || this._lists();
        let powers = this._powers(keep, readNumber, found);
        return {
            temperatures: this._temperatures(keep, readNumber, found),
            fans: found.fans.filter(keep).map(sensor => this._fan(sensor, readNumber)),
            powers: powers.readings,
            packageWatts: powers.packageWatts,
        };
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._ioScope.cancel();
        this._onChanged = function () {};
        this._discovering = false;
        this._discoverAgain = false;
        let waiters = this._discoverWaiters.splice(0)
            .concat(this._discoverNextWaiters.splice(0), this._refreshWaiters.splice(0));
        this._refreshing = false;
        this._refreshPending = false;
        this._refreshChanged = false;
        /* Every callback above belongs to work accepted before destruction.
         * Cancelled I/O may never reach its ordinary completion, so teardown
         * itself is the one explicit unsuccessful completion. */
        let firstError = null;
        for (let waiter of waiters) {
            try {
                waiter(false);
            } catch (error) {
                firstError = firstError || error;
            }
        }
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        if (firstError)
            throw firstError;
    }
};
