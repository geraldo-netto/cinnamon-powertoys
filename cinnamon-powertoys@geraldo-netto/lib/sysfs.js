/*
 * cinnamon-powertoys - sysfs access layer.
 *
 * Everything here is best effort: a node that is missing, root-only or busy
 * (amdgpu returns EBUSY while the card is asleep) yields null instead of
 * throwing, so the caller can simply hide that row.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

var HWMON_DIR = "/sys/class/hwmon";
var THERMAL_DIR = "/sys/class/thermal";
var POWERCAP_DIR = "/sys/class/powercap";
var CPU_DIR = "/sys/devices/system/cpu";
var CPUFREQ_DIR = CPU_DIR + "/cpufreq";
var POWER_SUPPLY_DIR = "/sys/class/power_supply";
var PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
var PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

function _decode(bytes) {
    if (typeof bytes === "string")
        return bytes;
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

function readString(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return _decode(contents).trim();
    } catch (e) {
        return null;
    }
}

function readNumber(path) {
    let raw = readString(path);
    if (raw === null || raw === "")
        return null;
    let value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function readWords(path) {
    let raw = readString(path);
    if (!raw)
        return [];
    return raw.split(/\s+/).filter(word => word.length > 0);
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function isReadable(path) {
    return readString(path) !== null;
}

function isUserWritable(path) {
    try {
        let info = Gio.File.new_for_path(path).query_info("access::can-write",
                                                          Gio.FileQueryInfoFlags.NONE,
                                                          null);
        return info.get_attribute_boolean("access::can-write");
    } catch (e) {
        return false;
    }
}

/* hwmon2 must sort before hwmon10 */
function _naturalCompare(a, b) {
    let re = /(\d+)/g;
    let pa = a.split(re), pb = b.split(re);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        let sa = pa[i] || "", sb = pb[i] || "";
        let na = Number(sa), nb = Number(sb);
        if (Number.isFinite(na) && Number.isFinite(nb) && sa !== "" && sb !== "") {
            if (na !== nb)
                return na - nb;
        } else if (sa !== sb) {
            return sa < sb ? -1 : 1;
        }
    }
    return 0;
}

function listDir(path) {
    let names = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(path).enumerate_children("standard::name",
                                                                    Gio.FileQueryInfoFlags.NONE,
                                                                    null);
    } catch (e) {
        return names;
    }
    let info;
    while ((info = enumerator.next_file(null)) !== null)
        names.push(info.get_name());
    enumerator.close(null);
    return names.sort(_naturalCompare);
}

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
    return readString(base + "/" + prefix + index + "_label");
}

/*
 * Something to tell two chips of the same name apart: the block device for
 * drivetemp, the PCI slot for two amdgpu cards, the controller name for nvme.
 */
function _hwmonIdentity(base) {
    let block = listDir(base + "/device/block");
    if (block.length > 0)
        return block[0];
    try {
        let target = GLib.file_read_link(base + "/device");
        if (target) {
            let name = GLib.path_get_basename(target);
            /* 0000:03:00.0 reads better as 03:00.0 */
            return name.replace(/^0000:/, "");
        }
    } catch (e) {
        /* not a symlink, or no device at all */
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

    for (let entry of listDir(HWMON_DIR)) {
        let base = HWMON_DIR + "/" + entry;
        let chip = readString(base + "/name") || entry;
        let kind = classifyChip(chip);
        let identity = _hwmonIdentity(base);
        chips.add(chip);

        let chipTemperatures = [];
        let chipFans = [];
        let chipPowerMeters = [];

        for (let node of listDir(base)) {
            let match = node.match(/^temp(\d+)_input$/);
            if (match) {
                let index = match[1];
                let critical = readNumber(base + "/temp" + index + "_crit");
                if (critical === null)
                    critical = readNumber(base + "/temp" + index + "_emergency");
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
                if (match[2] === "input" && exists(base + "/power" + index + "_average"))
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
                    capPath: exists(base + "/power" + index + "_cap")
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

    for (let entry of listDir(THERMAL_DIR)) {
        if (!/^thermal_zone\d+$/.test(entry))
            continue;
        let base = THERMAL_DIR + "/" + entry;
        let type = readString(base + "/type");
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
    for (let node of listDir(base)) {
        let match = node.match(/^trip_point_(\d+)_type$/);
        if (!match)
            continue;
        let type = readString(base + "/" + node);
        if (type !== "critical")
            continue;
        let value = readNumber(base + "/trip_point_" + match[1] + "_temp");
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
    for (let entry of listDir(POWERCAP_DIR)) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let energyPath = base + "/energy_uj";
        if (!exists(energyPath) || !isReadable(energyPath))
            continue;
        counters.push({
            id: "rapl:" + entry,
            label: readString(base + "/name") || entry,
            path: energyPath,
            maxRange: readNumber(base + "/max_energy_range_uj"),
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
        let value = readNumber(this.counter.path);
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
        this.policies = listDir(CPUFREQ_DIR)
            .filter(name => /^policy\d+$/.test(name))
            .map(name => CPUFREQ_DIR + "/" + name);
        this.reference = this.policies.length > 0 ? this.policies[0] : null;

        this.driver = this.reference ? readString(this.reference + "/scaling_driver") : null;
        this.governors = this.reference ? readWords(this.reference + "/scaling_available_governors") : [];
        this.energyPreferences = this.reference
            ? readWords(this.reference + "/energy_performance_available_preferences") : [];
        this.amdPstateStatus = readString(CPU_DIR + "/amd_pstate/status");

        this.boostPath = null;
        this.boostInverted = false;
        if (exists(CPUFREQ_DIR + "/boost")) {
            this.boostPath = CPUFREQ_DIR + "/boost";
        } else if (exists(CPU_DIR + "/intel_pstate/no_turbo")) {
            this.boostPath = CPU_DIR + "/intel_pstate/no_turbo";
            this.boostInverted = true;
        }
    }

    get available() {
        return this.policies.length > 0;
    }

    get coreCount() {
        return listDir(CPU_DIR).filter(name => /^cpu\d+$/.test(name)).length;
    }

    get governor() {
        return this.reference ? readString(this.reference + "/scaling_governor") : null;
    }

    get energyPreference() {
        return this.reference ? readString(this.reference + "/energy_performance_preference") : null;
    }

    get boostSupported() {
        return this.boostPath !== null;
    }

    get boostEnabled() {
        if (!this.boostPath)
            return null;
        let value = readNumber(this.boostPath);
        if (value === null)
            return null;
        return this.boostInverted ? value === 0 : value === 1;
    }

    /* Average of the current frequency of every policy, in MHz. */
    averageFrequency() {
        let total = 0;
        let count = 0;
        for (let policy of this.policies) {
            let value = readNumber(policy + "/cpuinfo_avg_freq");
            if (value === null)
                value = readNumber(policy + "/scaling_cur_freq");
            if (value === null)
                continue;
            total += value;
            count++;
        }
        return count > 0 ? (total / count) / 1000 : null;
    }

    maxFrequency() {
        let value = this.reference ? readNumber(this.reference + "/cpuinfo_max_freq") : null;
        return value === null ? null : value / 1000;
    }
};

/*
 * Charge limit support, as exposed by thinkpad_acpi, asus-wmi, huawei-wmi and
 * friends. Only the end threshold is offered, it is the one that matters for
 * battery longevity.
 */
function discoverChargeControl() {
    for (let name of listDir(POWER_SUPPLY_DIR)) {
        let base = POWER_SUPPLY_DIR + "/" + name;
        if (readString(base + "/type") !== "Battery")
            continue;
        let endPath = base + "/charge_control_end_threshold";
        if (!exists(endPath))
            continue;
        return {
            battery: name,
            path: endPath,
            value: readNumber(endPath),
        };
    }
    return null;
}

/* ACPI platform profile, used as a fallback when power-profiles-daemon is absent. */
function platformProfile() {
    if (!exists(PLATFORM_PROFILE))
        return null;
    return {
        active: readString(PLATFORM_PROFILE),
        choices: readWords(PLATFORM_PROFILE_CHOICES),
    };
}
