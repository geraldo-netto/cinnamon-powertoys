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

const _ = Format._;

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

function _label(base, prefix, index) {
    return IO.readString(base + "/" + prefix + index + "_label");
}

/*
 * Something to tell two chips of the same name apart: the block device for
 * drivetemp, the PCI slot for two amdgpu cards, the controller name for nvme.
 */
function _hwmonIdentity(base) {
    let block = IO.listDir(base + "/device/block");
    if (block.length > 0)
        return block[0];
    let target = IO.readLink(base + "/device");
    if (target) {
        let name = GLib.path_get_basename(target);
        /* 0000:03:00.0 reads better as 03:00.0 */
        return name.replace(/^0000:/, "");
    }
    return null;
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
    [/^tccd(\d+)$/i, match => _("Core die") + " " + match[1] + " (" + match[0] + ")"],
    [/^tccd$/i, match => _("Core die") + " (" + match[0] + ")"],
    [/^tdie$/i, match => _("Measured die") + " (" + match[0] + ")"],
    [/^tctl$/i, match => _("Cooling control") + " (" + match[0] + ")"],
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
function _nameGroups(groups) {
    let cpuName = Hardware.cpuModelName();
    let pciNames = Hardware.pciDeviceNames(groups.map(group => group.pciAddress));

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
        /* The chip's own limit, which is what a reading gets flagged
         * against. Some drivers only publish the emergency one. */
        extra: function (base, index) {
            let critical = IO.readNumber(base + "/temp" + index + "_crit");
            if (critical === null)
                critical = IO.readNumber(base + "/temp" + index + "_emergency");
            return { critical: critical === null ? null : critical / 1000 };
        },
    },
    {
        prefix: "fan",
        measure: "fan",
        list: "fans",
        pattern: /^fan(\d+)_input$/,
    },
    {
        prefix: "power",
        measure: "power",
        list: "powerMeters",
        /* powerN_average is the driver's own averaged value, powerN_input the
         * instantaneous one. Both are microwatts. */
        pattern: /^power(\d+)_(average|input)$/,
        skip: function (base, index, match) {
            return match[2] === "input" && IO.exists(base + "/power" + index + "_average");
        },
    },
];

/*
 * Discovers every temperature, fan and power meter exposed by hwmon plus any
 * thermal zone that hwmon does not already cover. Values are not read here,
 * only the paths to read later.
 */
function discoverSensors() {
    let found = { temperatures: [], fans: [], powerMeters: [] };
    let chips = new Set();
    let groups = [];

    for (let entry of IO.listDir(HWMON_DIR)) {
        let base = HWMON_DIR + "/" + entry;
        let chip = IO.readString(base + "/name") || entry;
        let kind = classifyChip(chip);
        let identity = _hwmonIdentity(base);
        let pciAddress = Hardware.pciAddressIn(IO.readLink(base + "/device"));
        let group = "hwmon:" + entry;
        chips.add(chip);
        groups.push({ key: group, chip: chip, kind: kind, identity: identity,
                      pciAddress: pciAddress });

        let ofThisChip = { temperatures: [], fans: [], powerMeters: [] };

        for (let node of IO.listDir(base)) {
            for (let nodeKind of NODE_KINDS) {
                let match = node.match(nodeKind.pattern);
                if (!match)
                    continue;

                let index = match[1];
                if (nodeKind.skip && nodeKind.skip(base, index, match))
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
                    rawLabel: _label(base, nodeKind.prefix, index),
                    path: base + "/" + node,
                };
                if (nodeKind.extra)
                    Object.assign(sensor, nodeKind.extra(base, index));

                ofThisChip[nodeKind.list].push(sensor);
                break;
            }
        }

        /* How many of its own kind this chip has, which decides whether an
         * unlabelled sensor needs its index in the name. */
        for (let list in ofThisChip) {
            for (let sensor of ofThisChip[list])
                sensor.siblings = ofThisChip[list].length;
            found[list] = found[list].concat(ofThisChip[list]);
        }
    }

    for (let entry of IO.listDir(THERMAL_DIR)) {
        if (!/^thermal_zone\d+$/.test(entry))
            continue;
        let base = THERMAL_DIR + "/" + entry;
        let type = IO.readString(base + "/type");
        if (!type || chips.has(type))
            continue;
        chips.add(type);
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
            rawLabel: null,
            path: base + "/temp",
            critical: _criticalTripPoint(base),
        });
    }

    /* One pass over everything, then split back out by what it measures. */
    let groupLabels = _nameGroups(groups);
    let named = _finalizeNames(found.temperatures.concat(found.fans, found.powerMeters))
        .map(entry => Object.assign({}, entry, { groupLabel: groupLabels[entry.group] || "" }));
    return {
        temperatures: named.filter(entry => entry.measure === "temperature"),
        fans: named.filter(entry => entry.measure === "fan"),
        powerMeters: named.filter(entry => entry.measure === "power"),
    };
}

function _criticalTripPoint(base) {
    for (let node of IO.listDir(base)) {
        let match = node.match(/^trip_point_(\d+)_type$/);
        if (!match)
            continue;
        let type = IO.readString(base + "/" + node);
        if (type !== "critical")
            continue;
        let value = IO.readNumber(base + "/trip_point_" + match[1] + "_temp");
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
        return packages > 1 ? _("Package") + " " + match[1] : _("Package");
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
function discoverEnergyCounters() {
    let found = [];
    for (let entry of IO.listDir(POWERCAP_DIR)) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let energyPath = base + "/energy_uj";
        if (!IO.exists(energyPath) || !IO.isReadable(energyPath))
            continue;
        found.push({
            entry: entry,
            base: base,
            energyPath: energyPath,
            raw: IO.readString(base + "/name") || entry,
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
        maxRange: IO.readNumber(item.base + "/max_energy_range_uj"),
        domain: item.entry,
        topLevel: RAPL_PACKAGE_DOMAIN.test(item.entry),
    }));
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
            /* The counter is a fixed width, so it wraps back to zero. */
            if (energy < 0 && this.counter.maxRange)
                energy += this.counter.maxRange;
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
    constructor() {
        this._topology = null;
        this.discover();
    }

    discover() {
        let found = discoverSensors();
        this.temperatureSensors = found.temperatures;
        this.fanSensors = found.fans;
        this.powerSensors = found.powerMeters;
        /* The meters keep the previous counter value between polls, so they
         * outlive a reading and are only rebuilt by a rediscovery. */
        this.energyMeters = discoverEnergyCounters().map(counter => new EnergyMeter(counter));
        this._topology = this._topologyKey();
    }

    /*
     * A cheap description of what is present: three directory listings. A
     * card waking up, a USB sensor being plugged in or a driver being loaded
     * adds or removes an entry in one of them.
     */
    _topologyKey() {
        return [IO.listDir(HWMON_DIR).join(","),
                IO.listDir(THERMAL_DIR).join(","),
                IO.listDir(POWERCAP_DIR).join(",")].join("|");
    }

    /*
     * Checks for hardware that has come or gone, and sweeps again only if
     * there is any. Answers whether it did.
     *
     * A driver that grows a new node inside a directory that was already
     * there is missed until the next real change; that is the price of not
     * re-reading every label file each time the menu is opened.
     */
    refresh() {
        if (this._topologyKey() === this._topology)
            return false;
        this.discover();
        return true;
    }

    _temperature(sensor, readNumber) {
        let raw = readNumber(sensor.path);
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

    _fan(sensor, readNumber) {
        return {
            id: sensor.id,
            measure: sensor.measure,
            chip: sensor.chip,
            kind: sensor.kind,
            label: Format.sensorLabel(sensor),
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            shortLabel: sensor.short,
            rpm: readNumber(sensor.path),
        };
    }

    _powers(keep, readNumber) {
        let readings = [];
        let packageWatts = null;

        for (let meter of this.energyMeters) {
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

        for (let sensor of this.powerSensors) {
            if (!keep(sensor))
                continue;
            let raw = readNumber(sensor.path);
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
        let keep = wanted || (() => true);
        IO.readStringsAsync(this._paths(keep), values => {
            onDone(this._assemble(keep, path => IO.toNumber(values[path])));
        });
    }

    /* Every node one reading touches, for whoever wants to load them first. */
    _paths(keep) {
        let paths = [];
        for (let sensor of this.temperatureSensors)
            if (keep(sensor))
                paths.push(sensor.path);
        for (let sensor of this.fanSensors)
            if (keep(sensor))
                paths.push(sensor.path);
        for (let meter of this.energyMeters)
            if (keep(meter))
                paths.push(meter.counter.path);
        for (let sensor of this.powerSensors)
            if (keep(sensor))
                paths.push(sensor.path);
        return paths;
    }

    _assemble(keep, readNumber) {
        let powers = this._powers(keep, readNumber);
        return {
            temperatures: this.temperatureSensors.filter(keep)
                .map(sensor => this._temperature(sensor, readNumber)),
            fans: this.fanSensors.filter(keep).map(sensor => this._fan(sensor, readNumber)),
            powers: powers.readings,
            packageWatts: powers.packageWatts,
        };
    }
};
