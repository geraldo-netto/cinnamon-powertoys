/*
 * cinnamon-powertoys - CPU scaling interface.
 *
 * cpufreq exposes one policy directory per core group. The settings that are
 * uniform across them - driver, governor, energy preference, boost - are read
 * from the first policy; the frequencies are read from all of them.
 */

const IO = require("./lib/io.js");

var CPU_DIR = "/sys/devices/system/cpu";
var CPUFREQ_DIR = CPU_DIR + "/cpufreq";

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
