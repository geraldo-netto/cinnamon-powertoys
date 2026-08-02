/*
 * cinnamon-powertoys - sysfs access layer.
 *
 * Reading, listing and path resolution live in lib/io.js; what is left here is
 * knowledge of the kernel interfaces themselves. Everything is best effort: a
 * node that is missing, root-only or busy yields null instead of throwing, so
 * the caller can simply hide that row.
 */

const GLib = imports.gi.GLib;

const IO = require("./lib/io.js");

var HWMON_DIR = "/sys/class/hwmon";
var THERMAL_DIR = "/sys/class/thermal";
var POWERCAP_DIR = "/sys/class/powercap";
var CPU_DIR = "/sys/devices/system/cpu";
var CPUFREQ_DIR = CPU_DIR + "/cpufreq";
var POWER_SUPPLY_DIR = "/sys/class/power_supply";
var PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
var PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

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

var CpuControl = class CpuControl {
    constructor() {
        this.refresh();
    }

    refresh() {
        this.policies = IO.listDir(CPUFREQ_DIR)
            .filter(name => /^policy\d+$/.test(name))
            .map(name => CPUFREQ_DIR + "/" + name);
        this.reference = this.policies.length > 0 ? this.policies[0] : null;

        this.driver = this.reference ? IO.readString(this.reference + "/scaling_driver") : null;
        this.governors = this.reference ? IO.readWords(this.reference + "/scaling_available_governors") : [];
        this.energyPreferences = this.reference
            ? IO.readWords(this.reference + "/energy_performance_available_preferences") : [];
        this.amdPstateStatus = IO.readString(CPU_DIR + "/amd_pstate/status");

        this.boostPath = null;
        this.boostInverted = false;
        if (IO.exists(CPUFREQ_DIR + "/boost")) {
            this.boostPath = CPUFREQ_DIR + "/boost";
        } else if (IO.exists(CPU_DIR + "/intel_pstate/no_turbo")) {
            this.boostPath = CPU_DIR + "/intel_pstate/no_turbo";
            this.boostInverted = true;
        }
    }

    get available() {
        return this.policies.length > 0;
    }

    get coreCount() {
        return IO.listDir(CPU_DIR).filter(name => /^cpu\d+$/.test(name)).length;
    }

    get governor() {
        return this.reference ? IO.readString(this.reference + "/scaling_governor") : null;
    }

    get energyPreference() {
        return this.reference ? IO.readString(this.reference + "/energy_performance_preference") : null;
    }

    get boostSupported() {
        return this.boostPath !== null;
    }

    get boostEnabled() {
        if (!this.boostPath)
            return null;
        let value = IO.readNumber(this.boostPath);
        if (value === null)
            return null;
        return this.boostInverted ? value === 0 : value === 1;
    }

    /* Average of the current frequency of every policy, in MHz. */
    averageFrequency() {
        let total = 0;
        let count = 0;
        for (let policy of this.policies) {
            let value = IO.readNumber(policy + "/cpuinfo_avg_freq");
            if (value === null)
                value = IO.readNumber(policy + "/scaling_cur_freq");
            if (value === null)
                continue;
            total += value;
            count++;
        }
        return count > 0 ? (total / count) / 1000 : null;
    }

    maxFrequency() {
        let value = this.reference ? IO.readNumber(this.reference + "/cpuinfo_max_freq") : null;
        return value === null ? null : value / 1000;
    }
};

/*
 * Charge limit support, as exposed by thinkpad_acpi, asus-wmi, huawei-wmi and
 * friends. Only the end threshold is offered, it is the one that matters for
 * battery longevity.
 */
function discoverChargeControl() {
    for (let name of IO.listDir(POWER_SUPPLY_DIR)) {
        let base = POWER_SUPPLY_DIR + "/" + name;
        if (IO.readString(base + "/type") !== "Battery")
            continue;
        let endPath = base + "/charge_control_end_threshold";
        if (!IO.exists(endPath))
            continue;
        return {
            battery: name,
            path: endPath,
            value: IO.readNumber(endPath),
        };
    }
    return null;
}

/* ACPI platform profile, used as a fallback when power-profiles-daemon is absent. */
function platformProfile() {
    if (!IO.exists(PLATFORM_PROFILE))
        return null;
    return {
        active: IO.readString(PLATFORM_PROFILE),
        choices: IO.readWords(PLATFORM_PROFILE_CHOICES),
    };
}
