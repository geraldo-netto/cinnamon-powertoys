/*
 * cinnamon-powertoys - CPU scaling interface.
 *
 * cpufreq exposes one policy directory per core group. The settings that are
 * uniform across them - driver, governor, energy preference, boost - are read
 * from the first policy; the frequencies are read from all of them.
 *
 * All of those nodes are owned by root, so writing one is not something this
 * module can do on its own. It takes a runner - in the applet, the pkexec
 * helper - and calls it with the command and the value. Read and write for a
 * setting then sit next to each other, rather than the getter being here and
 * the name of the setting being spelled out again at the call site.
 */

const IO = require("./lib/io.js");

var CPU_DIR = "/sys/devices/system/cpu";
var CPUFREQ_DIR = CPU_DIR + "/cpufreq";

/*
 * A field that is only worked out if somebody reads it, and then only once.
 * Used for the values in a reading that are expensive to produce and that
 * most configurations never display.
 */
function _lazy(object, name, produce) {
    let value = null;
    let produced = false;
    Object.defineProperty(object, name, {
        configurable: true,
        enumerable: true,
        get: () => {
            if (!produced) {
                value = produce();
                produced = true;
            }
            return value;
        },
    });
    return object;
}

var CpuControl = class CpuControl {
    constructor(runner) {
        this._runner = runner || function () {};
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

    /* The names below are the helper's vocabulary, and the only place in the
     * applet that knows them. */
    setGovernor(name, onDone) {
        this._runner(["governor", String(name)], onDone);
    }

    get energyPreference() {
        return this.reference ? IO.readString(this.reference + "/energy_performance_preference") : null;
    }

    setEnergyPreference(name, onDone) {
        this._runner(["epp", String(name)], onDone);
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

    /* The helper knows about the intel_pstate inversion too, so it is told
     * what the user asked for and not what to write. */
    setBoost(enabled, onDone) {
        this._runner(["boost", enabled ? "1" : "0"], onDone);
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

    /*
     * Everything anyone asks about the CPU, in one reading.
     *
     * Which of these mean anything depends on the machine - there is no
     * energy preference without an epp capable driver, no boost switch
     * without one of the two nodes, nothing at all without cpufreq - and this
     * class is where that is known, so the caller gets an empty list or a
     * null rather than having to ask first.
     */
    snapshot() {
        let reading = {
            available: this.available,
            driver: this.driver,
            governor: this.governor,
            governors: this.governors,
            energyPreference: this.energyPreference,
            energyPreferences: this.energyPreferences,
            boostSupported: this.boostSupported,
            boostEnabled: this.boostEnabled,
            maxFrequency: this.maxFrequency(),
            amdPstateStatus: this.amdPstateStatus,
        };

        /* The current frequency is the one value here that costs a file read
         * per policy - 32 of them on a sixteen core machine, every few
         * seconds - and it is also the one a configuration can be showing
         * nowhere. So it is worked out when somebody asks for it, which on a
         * panel without the frequency and with the CPU section turned off is
         * never. */
        return _lazy(reading, "averageFrequency", () => this.averageFrequency());
    }
};
