/*
 * cinnamon-powertoys - temperature, fan and power sensor discovery.
 *
 * Covers hwmon, the thermal zones hwmon does not already account for, and the
 * powercap energy counters. Discovery records where to read and what the
 * reading is called; the values themselves are read later, one poll at a time.
 */

const GLib = imports.gi.GLib;

const Format = require("./lib/format.js");
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

/* Temperatures, fans and meters listed together, interesting kinds first. */
function bySensorOrder(a, b) {
    let rankA = kindRank(a.kind);
    let rankB = kindRank(b.kind);
    if (rankA !== rankB)
        return rankA - rankB;
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
 * Builds the name shown in the menu. "k10temp Tctl" rather than "Tctl", and a
 * disambiguating suffix when several chips would otherwise collide, as five
 * drivetemp instances do.
 */
function _finalizeNames(entries) {
    for (let entry of entries) {
        let chip = entry.chip;
        let label = entry.rawLabel;
        if (!label)
            entry.display = entry.siblings > 1 ? chip + " " + entry.index : chip;
        else if (label.toLowerCase().indexOf(chip.toLowerCase()) === 0)
            entry.display = label;
        else
            entry.display = chip + " " + label;
    }

    let counts = {};
    for (let entry of entries)
        counts[entry.display] = (counts[entry.display] || 0) + 1;

    for (let entry of entries) {
        if (counts[entry.display] > 1 && entry.identity)
            entry.display = entry.display + " (" + entry.identity + ")";
    }
    return entries;
}

/*
 * Discovers every temperature, fan and power meter exposed by hwmon plus any
 * thermal zone that hwmon does not already cover. Values are not read here,
 * only the paths to read later.
 */
function discoverSensors() {
    let temperatures = [];
    let fans = [];
    let powerMeters = [];
    let chips = new Set();

    for (let entry of IO.listDir(HWMON_DIR)) {
        let base = HWMON_DIR + "/" + entry;
        let chip = IO.readString(base + "/name") || entry;
        let kind = classifyChip(chip);
        let identity = _hwmonIdentity(base);
        chips.add(chip);

        let chipTemperatures = [];
        let chipFans = [];
        let chipPowerMeters = [];

        for (let node of IO.listDir(base)) {
            let match = node.match(/^temp(\d+)_input$/);
            if (match) {
                let index = match[1];
                let critical = IO.readNumber(base + "/temp" + index + "_crit");
                if (critical === null)
                    critical = IO.readNumber(base + "/temp" + index + "_emergency");
                chipTemperatures.push({
                    id: "hwmon:" + entry + ":temp" + index,
                    measure: "temperature",
                    source: "hwmon",
                    chip: chip,
                    kind: kind,
                    index: index,
                    identity: identity,
                    rawLabel: _label(base, "temp", index),
                    path: base + "/" + node,
                    critical: critical === null ? null : critical / 1000,
                });
                continue;
            }

            match = node.match(/^fan(\d+)_input$/);
            if (match) {
                let index = match[1];
                chipFans.push({
                    id: "hwmon:" + entry + ":fan" + index,
                    measure: "fan",
                    source: "hwmon",
                    chip: chip,
                    kind: kind,
                    index: index,
                    identity: identity,
                    rawLabel: _label(base, "fan", index),
                    path: base + "/" + node,
                });
                continue;
            }

            /* powerN_average is the driver's own averaged value, powerN_input
             * the instantaneous one. Both are microwatts. */
            match = node.match(/^power(\d+)_(average|input)$/);
            if (match) {
                let index = match[1];
                if (match[2] === "input" && IO.exists(base + "/power" + index + "_average"))
                    continue;
                chipPowerMeters.push({
                    id: "hwmon:" + entry + ":power" + index,
                    measure: "power",
                    source: "hwmon",
                    chip: chip,
                    kind: kind,
                    index: index,
                    identity: identity,
                    rawLabel: _label(base, "power", index),
                    path: base + "/" + node,
                    capPath: IO.exists(base + "/power" + index + "_cap")
                        ? base + "/power" + index + "_cap" : null,
                });
            }
        }

        for (let list of [chipTemperatures, chipFans, chipPowerMeters]) {
            for (let sensor of list)
                sensor.siblings = list.length;
        }
        temperatures = temperatures.concat(chipTemperatures);
        fans = fans.concat(chipFans);
        powerMeters = powerMeters.concat(chipPowerMeters);
    }

    for (let entry of IO.listDir(THERMAL_DIR)) {
        if (!/^thermal_zone\d+$/.test(entry))
            continue;
        let base = THERMAL_DIR + "/" + entry;
        let type = IO.readString(base + "/type");
        if (!type || chips.has(type))
            continue;
        chips.add(type);
        temperatures.push({
            id: "thermal:" + entry,
            measure: "temperature",
            source: "thermal",
            chip: type,
            kind: classifyChip(type),
            index: "1",
            siblings: 1,
            identity: entry,
            rawLabel: null,
            path: base + "/temp",
            critical: _criticalTripPoint(base),
        });
    }

    return {
        temperatures: _finalizeNames(temperatures),
        fans: _finalizeNames(fans),
        powerMeters: _finalizeNames(powerMeters),
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
 * RAPL / powercap energy counters. Since CVE-2020-8694 energy_uj is usually
 * 0400, so this returns an empty list on most systems - that is expected and
 * simply means no package power readout.
 */
function discoverEnergyCounters() {
    let counters = [];
    for (let entry of IO.listDir(POWERCAP_DIR)) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let energyPath = base + "/energy_uj";
        if (!IO.exists(energyPath) || !IO.isReadable(energyPath))
            continue;
        counters.push({
            id: "rapl:" + entry,
            measure: "power",
            kind: "package",
            label: IO.readString(base + "/name") || entry,
            path: energyPath,
            maxRange: IO.readNumber(base + "/max_energy_range_uj"),
            domain: entry,
            topLevel: RAPL_PACKAGE_DOMAIN.test(entry),
        });
    }
    return counters;
}

/* Turns a monotonic microjoule counter into watts. */
var EnergyMeter = class EnergyMeter {
    constructor(counter) {
        this.counter = counter;
        this.id = counter.id;
        this.measure = counter.measure;
        this.kind = counter.kind;
        this.label = counter.label;
        this.domain = counter.domain;
        /* whether this counter may be added into a whole-package total */
        this.topLevel = counter.topLevel;
        this.watts = null;
        this._lastValue = null;
        this._lastTime = 0;
    }

    sample() {
        let value = IO.readNumber(this.counter.path);
        let now = GLib.get_monotonic_time();
        if (value === null) {
            this.watts = null;
            this._lastValue = null;
            return null;
        }
        if (this._lastValue !== null) {
            let energy = value - this._lastValue;
            if (energy < 0 && this.counter.maxRange)
                energy += this.counter.maxRange;
            let elapsed = now - this._lastTime;
            /* microjoules per microsecond is watts */
            if (elapsed > 0 && energy >= 0)
                this.watts = energy / elapsed;
        }
        this._lastValue = value;
        this._lastTime = now;
        return this.watts;
    }
};
