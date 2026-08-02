/*
 * cinnamon-powertoys - temperature, fan and power sensor discovery.
 *
 * Covers hwmon, the thermal zones hwmon does not already account for, and the
 * powercap energy counters. Discovery records where to read and what the
 * reading is called; the values themselves are read later, one poll at a time.
 */

const GLib = imports.gi.GLib;

const IO = require("./lib/io.js");

var HWMON_DIR = "/sys/class/hwmon";
var THERMAL_DIR = "/sys/class/thermal";
var POWERCAP_DIR = "/sys/class/powercap";

const CHIP_KINDS = [
    { kind: "cpu",     pattern: /^(k10temp|zenpower|coretemp|cpu_thermal|cpu-thermal|x86_pkg_temp|soc_thermal|cpu\d*_thermal)/i },
    { kind: "gpu",     pattern: /^(amdgpu|radeon|nouveau|nvidia|i915|xe|gpu_thermal|gpu-thermal)/i },
    { kind: "disk",    pattern: /^(nvme|drivetemp)/i },
    { kind: "network", pattern: /^(iwlwifi|ath\d*k|mt79|mt76|rtw|brcm|r8\d{3}|igb|igc|e1000|ixgbe)/i },
    { kind: "board",   pattern: /^(acpitz|pch_|nct\d|it87|thinkpad|asus|dell_smm|gigabyte|corsair)/i },
    { kind: "battery", pattern: /^(bat\d*|bq\d|max\d{4}|rt\d{4})/i },
];

function classifyChip(name) {
    for (let entry of CHIP_KINDS) {
        if (entry.pattern.test(name))
            return entry.kind;
    }
    return "other";
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
            label: IO.readString(base + "/name") || entry,
            path: energyPath,
            maxRange: IO.readNumber(base + "/max_energy_range_uj"),
            domain: entry,
        });
    }
    return counters;
}

/* Turns a monotonic microjoule counter into watts. */
var EnergyMeter = class EnergyMeter {
    constructor(counter) {
        this.counter = counter;
        this.id = counter.id;
        this.label = counter.label;
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
