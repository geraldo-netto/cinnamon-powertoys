/*
 * cinnamon-powertoys - sysfs access layer.
 *
 * Reading and listing live in lib/io.js, sensor discovery in lib/sensors.js;
 * what is left here is the CPU scaling interface and the two power supply
 * nodes. Everything is best effort: a node that is missing, root-only or busy
 * yields null instead of throwing, so the caller can simply hide that row.
 */

const IO = require("./lib/io.js");

var CPU_DIR = "/sys/devices/system/cpu";
var CPUFREQ_DIR = CPU_DIR + "/cpufreq";
var POWER_SUPPLY_DIR = "/sys/class/power_supply";
var PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
var PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

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
