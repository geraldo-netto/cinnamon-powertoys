/*
 * Walking sysfs, and what comes back from it.
 *
 * hwmon, the thermal zones hwmon does not already account for, and the
 * powercap directory listing the counters are read from. This finds where to
 * read and records what the reading is called; the values themselves are read
 * later, one poll at a time, by the objects in lib/sensors.js.
 *
 * Every path in this file is a fact about the kernel's sysfs layout, and none
 * of it holds any state: a sweep goes in as directories and readers, a listing
 * of sensors comes out. Both a synchronous sweep and an asynchronous one are
 * here, and they are the same scan over two ways of getting a value, which is
 * why they cannot say different things.
 */

const GLib = imports.gi.GLib;

const Energy = require("./lib/energy.js");
const Format = require("./lib/format.js");
const Hardware = require("./lib/hardware.js");
const IO = require("./lib/io.js");
const Kinds = require("./lib/sensor-kinds.js");
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
function directoryInventory() {
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

function scanSensors(directories, readString, readLink) {
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

function finishSensors(scanned, groupLabels) {
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
    let directories = directoryInventory();
    let scanned = scanSensors(directories, IO.readString);
    return finishSensors(scanned, Kinds.nameGroups(scanned.groups));
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

function _nestedTopology(directories, root) {
    return (directories[root] || []).map(entry => {
        let base = root + "/" + entry;
        return entry + "[" + (directories[base] || []).join(",") + "]";
    }).join(",");
}

function topologyFromInventory(directories, readString, readLink, canRead) {
    let powercap = directories[POWERCAP_DIR] || [];
    let metadata = _metadataPaths(directories)
        /* The counter value moves continuously; only whether it can be read
         * is topology, and that is represented by Energy.powercapTopology. */
        .filter(path => !/\/(?:energy_uj|power_uw)$/.test(path))
        .map(path => [path, readString(path)]);
    let links = _linkPaths(directories).map(path => [path, readLink(path)]);
    return JSON.stringify([
        _nestedTopology(directories, HWMON_DIR),
        _nestedTopology(directories, THERMAL_DIR),
        Energy.powercapTopology(powercap, canRead || (path => readString(path) !== null)),
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
function loadInventoryAsync(onDone, ioOptions) {
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
        IO.pathsReadableAsync(Energy.powercapAccessPaths(directories[POWERCAP_DIR] || []),
            values => {
                access = values;
                finish();
            }, 32, null, ioOptions);
    }, ioOptions);
}

/* The refresh check's answer: what is present, from one loaded inventory. */
function inventoryTopology(inventory) {
    return topologyFromInventory(inventory.directories, inventory.read,
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
    let scanned = scanSensors(inventory.directories, read, inventory.readLink);
    let addresses = scanned.groups.map(group => group.pciAddress);
    Hardware.machineNamesAsync(addresses, names => {
        let labels = Kinds.nameGroupsFrom(scanned.groups, names.cpuName, names.pciNames);
        onDone({
            sensors: finishSensors(scanned, labels),
            counters: Energy.energyCounters(powercap, read, readable),
            directPowers: Energy.directPowercapSensors(powercap, read, readable),
            topology: inventoryTopology(inventory),
        });
    }, ioOptions);
}

/* One complete sensor snapshot, assembled only after every asynchronous part
 * has answered. Until this callback, callers keep using the prior snapshot. */
function discoverSnapshotAsync(onDone, ioOptions) {
    loadInventoryAsync(inventory =>
        snapshotFromInventoryAsync(inventory, onDone, ioOptions), ioOptions);
}

function discoverSensorsAsync(onDone, ioOptions) {
    discoverSnapshotAsync(snapshot => onDone(snapshot.sensors), ioOptions);
}

