/*
 * cinnamon-powertoys - CPU scaling interface.
 *
 * cpufreq exposes one policy directory per core group. Governors and energy
 * preferences are per-policy: only choices shared by every target are safe to
 * offer, and a current value exists only while all of those targets agree.
 * Current and maximum frequencies likewise use every policy.
 *
 * All of those nodes are owned by root, so writing one is not something this
 * module can do on its own. It takes a runner - in the applet, the pkexec
 * helper - and calls it with the command and the value. Read and write for a
 * setting then sit next to each other, rather than the getter being here and
 * the name of the setting being spelled out again at the call site.
 */

const Hardware = require("./lib/hardware.js");
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

function _intersection(lists) {
    if (lists.length === 0)
        return [];
    return lists[0].filter((value, index) =>
        lists[0].indexOf(value) === index &&
        lists.every(list => list.indexOf(value) >= 0));
}

function _agreed(paths, node) {
    if (paths.length === 0)
        return null;
    let values = paths.map(path => IO.readString(path + "/" + node));
    if (values.some(value => value === null))
        return null;
    return values.every(value => value === values[0]) ? values[0] : null;
}

var CpuControl = class CpuControl {
    constructor(runner, options) {
        let configuration = options || {};
        this._runner = runner || function () {};
        this._asynchronous = !!configuration.asynchronous;
        this._onChanged = configuration.onChanged || function () {};
        this._refreshing = false;
        this._refreshPending = false;
        this._refreshWaiters = [];
        this._stateGeneration = 0;
        this._destroyed = false;

        this.policies = [];
        this.reference = null;
        this.driver = null;
        this.governors = [];
        this.energyPolicies = [];
        this.energyPreferences = [];
        this.amdPstateStatus = null;
        this.model = null;
        this._maxFrequency = null;
        this.boostPath = null;
        this.boostInverted = false;
        this._governor = null;
        this._energyPreference = null;
        this._boostEnabled = null;
        this._averageFrequency = null;

        this.refresh();
    }

    refresh(onDone) {
        if (!this._asynchronous) {
            this._refreshSync();
            if (onDone)
                onDone(true);
            return;
        }
        if (this._destroyed)
            return;
        if (onDone)
            this._refreshWaiters.push(onDone);
        if (this._refreshing) {
            /* The current discovery may have begun before this request and
             * therefore cannot prove what is true after it. Keep one replay;
             * any number of overlapping requests need only one newer sweep. */
            this._refreshPending = true;
            return;
        }
        this._startRefresh();
    }

    _startRefresh() {
        this._refreshing = true;
        this._discoverAsync(state => {
            if (this._destroyed)
                return;
            this._adopt(state);
            if (this._refreshPending) {
                this._refreshPending = false;
                this._startRefresh();
                return;
            }
            this._refreshing = false;
            let waiters = this._refreshWaiters.splice(0);
            for (let waiter of waiters)
                waiter(true);
            this._onChanged();
        });
    }

    _refreshSync() {
        this.policies = IO.listDir(CPUFREQ_DIR)
            .filter(name => /^policy\d+$/.test(name))
            .map(name => CPUFREQ_DIR + "/" + name);
        this.reference = this.policies.length > 0 ? this.policies[0] : null;

        this.driver = this.reference ? IO.readString(this.reference + "/scaling_driver") : null;
        this.governors = _intersection(this.policies.map(policy =>
            IO.readWords(policy + "/scaling_available_governors")));
        this.energyPolicies = this.policies.filter(policy =>
            IO.exists(policy + "/energy_performance_preference"));
        this.energyPreferences = _intersection(this.energyPolicies.map(policy =>
            IO.readWords(policy + "/energy_performance_available_preferences")));
        this.amdPstateStatus = IO.readString(CPU_DIR + "/amd_pstate/status");

        /* What the chip is called, so a reading can be filed under the same
         * heading the sensors off that chip are filed under. */
        this.model = Hardware.cpuModelName();

        /*
         * The ceiling the silicon was built with. It is read here with the
         * rest of what a scaling driver swap can change, rather than on every
         * poll with the values that actually move: nothing short of new
         * hardware alters it, and a poll is IO on the thread that draws.
         */
        this._maxFrequency = null;
        for (let policy of this.policies) {
            let maximum = IO.readNumber(policy + "/cpuinfo_max_freq");
            if (maximum !== null && maximum > 0 &&
                    (this._maxFrequency === null || maximum > this._maxFrequency))
                this._maxFrequency = maximum;
        }

        this.boostPath = null;
        this.boostInverted = false;
        if (IO.exists(CPUFREQ_DIR + "/boost")) {
            this.boostPath = CPUFREQ_DIR + "/boost";
        } else if (IO.exists(CPU_DIR + "/intel_pstate/no_turbo")) {
            this.boostPath = CPU_DIR + "/intel_pstate/no_turbo";
            this.boostInverted = true;
        }
    }

    /* One complete CPU snapshot, assembled after every asynchronous listing,
     * value and existence query has answered. The live fields are untouched
     * until onDone, so a menu open during this work keeps drawing the prior
     * coherent machine rather than a half-refreshed one. */
    _discoverAsync(onDone) {
        IO.listDirAsync(CPUFREQ_DIR, entries => {
            let policies = entries.filter(name => /^policy\d+$/.test(name))
                .map(name => CPUFREQ_DIR + "/" + name);
            let valuePaths = [CPU_DIR + "/amd_pstate/status",
                              CPUFREQ_DIR + "/boost",
                              CPU_DIR + "/intel_pstate/no_turbo"];
            let existencePaths = [CPUFREQ_DIR + "/boost",
                                  CPU_DIR + "/intel_pstate/no_turbo"];
            for (let policy of policies) {
                valuePaths.push(policy + "/scaling_driver",
                                policy + "/scaling_available_governors",
                                policy + "/scaling_governor",
                                policy + "/energy_performance_preference",
                                policy + "/energy_performance_available_preferences",
                                policy + "/cpuinfo_max_freq",
                                policy + "/cpuinfo_avg_freq",
                                policy + "/scaling_cur_freq");
                existencePaths.push(policy + "/energy_performance_preference");
            }

            let values = null;
            let existence = null;
            let names = null;
            let finish = () => {
                if (values === null || existence === null || names === null)
                    return;
                onDone(this._stateFrom(policies, values, existence, names.cpuName));
            };
            IO.readStringsAsync(valuePaths, answer => {
                values = answer;
                finish();
            }, 32);
            IO.pathsExistAsync(existencePaths, answer => {
                existence = answer;
                finish();
            }, 32);
            Hardware.machineNamesAsync([], answer => {
                names = answer;
                finish();
            });
        });
    }

    _stateFrom(policies, values, existence, model) {
        let read = path => values[path] === undefined ? null : values[path];
        let words = path => {
            let raw = read(path);
            return raw ? raw.split(/\s+/) : [];
        };
        let energyPolicies = policies.filter(policy =>
            existence[policy + "/energy_performance_preference"]);
        let maximum = null;
        for (let policy of policies) {
            let max = IO.toNumber(read(policy + "/cpuinfo_max_freq"));
            if (max !== null && max > 0 && (maximum === null || max > maximum))
                maximum = max;
        }

        let boostPath = null;
        let boostInverted = false;
        if (existence[CPUFREQ_DIR + "/boost"])
            boostPath = CPUFREQ_DIR + "/boost";
        else if (existence[CPU_DIR + "/intel_pstate/no_turbo"]) {
            boostPath = CPU_DIR + "/intel_pstate/no_turbo";
            boostInverted = true;
        }
        return Object.assign({
            policies: policies,
            reference: policies.length > 0 ? policies[0] : null,
            driver: policies.length > 0 ? read(policies[0] + "/scaling_driver") : null,
            governors: _intersection(policies.map(policy =>
                words(policy + "/scaling_available_governors"))),
            energyPolicies: energyPolicies,
            energyPreferences: _intersection(energyPolicies.map(policy =>
                words(policy + "/energy_performance_available_preferences"))),
            amdPstateStatus: read(CPU_DIR + "/amd_pstate/status"),
            model: model,
            maxFrequency: maximum,
            boostPath: boostPath,
            boostInverted: boostInverted,
        }, this._dynamicFrom(policies, energyPolicies, boostPath, boostInverted, read));
    }

    _dynamicPaths(policies, energyPolicies, boostPath) {
        let paths = [];
        for (let policy of policies)
            paths.push(policy + "/scaling_governor",
                       policy + "/cpuinfo_avg_freq",
                       policy + "/scaling_cur_freq");
        for (let policy of energyPolicies)
            paths.push(policy + "/energy_performance_preference");
        if (boostPath)
            paths.push(boostPath);
        return paths;
    }

    _dynamicFrom(policies, energyPolicies, boostPath, boostInverted, read) {
        let agreed = (targets, node) => {
            if (targets.length === 0)
                return null;
            let answers = targets.map(path => read(path + "/" + node));
            if (answers.some(value => value === null))
                return null;
            return answers.every(value => value === answers[0]) ? answers[0] : null;
        };
        let total = 0;
        let count = 0;
        for (let policy of policies) {
            let current = IO.toNumber(read(policy + "/cpuinfo_avg_freq"));
            if (current === null)
                current = IO.toNumber(read(policy + "/scaling_cur_freq"));
            if (current !== null) {
                total += current;
                count++;
            }
        }
        let boostValue = boostPath ? IO.toNumber(read(boostPath)) : null;
        return {
            governor: agreed(policies, "scaling_governor"),
            energyPreference: agreed(energyPolicies, "energy_performance_preference"),
            boostEnabled: boostValue === null ? null
                : (boostInverted ? boostValue === 0 : boostValue === 1),
            averageFrequency: count > 0 ? (total / count) / 1000 : null,
        };
    }

    _adopt(state) {
        this._stateGeneration++;
        this.policies = state.policies;
        this.reference = state.reference;
        this.driver = state.driver;
        this.governors = state.governors;
        this.energyPolicies = state.energyPolicies;
        this.energyPreferences = state.energyPreferences;
        this.amdPstateStatus = state.amdPstateStatus;
        this.model = state.model;
        this._maxFrequency = state.maxFrequency;
        this.boostPath = state.boostPath;
        this.boostInverted = state.boostInverted;
        this._governor = state.governor;
        this._energyPreference = state.energyPreference;
        this._boostEnabled = state.boostEnabled;
        this._averageFrequency = state.averageFrequency;
    }

    _adoptDynamic(state) {
        this._governor = state.governor;
        this._energyPreference = state.energyPreference;
        this._boostEnabled = state.boostEnabled;
        this._averageFrequency = state.averageFrequency;
    }

    /* Read only values that move between topology discoveries. The policy
     * lists and paths are captured together, and a full refresh invalidates
     * the answer if it adopts a different machine while these reads are in
     * flight. */
    sample(onDone) {
        let done = onDone || function () {};
        if (!this._asynchronous) {
            done(true);
            return;
        }
        if (this._destroyed) {
            done(false);
            return;
        }

        let generation = this._stateGeneration;
        let policies = this.policies.slice();
        let energyPolicies = this.energyPolicies.slice();
        let boostPath = this.boostPath;
        let boostInverted = this.boostInverted;
        let paths = this._dynamicPaths(policies, energyPolicies, boostPath);
        IO.readStringsAsync(paths, values => {
            if (this._destroyed || generation !== this._stateGeneration) {
                done(false);
                return;
            }
            let read = path => values[path] === undefined ? null : values[path];
            this._adoptDynamic(this._dynamicFrom(
                policies, energyPolicies, boostPath, boostInverted, read));
            done(true);
        }, 32);
    }

    get available() {
        return this.policies.length > 0;
    }

    get governor() {
        if (this._asynchronous)
            return this._governor;
        return _agreed(this.policies, "scaling_governor");
    }

    /* The names below are the helper's vocabulary, and the only place in the
     * applet that knows them. */
    setGovernor(name, onDone) {
        this._runner(["governor", String(name)], onDone);
    }

    get energyPreference() {
        if (this._asynchronous)
            return this._energyPreference;
        return _agreed(this.energyPolicies, "energy_performance_preference");
    }

    setEnergyPreference(name, onDone) {
        this._runner(["epp", String(name)], onDone);
    }

    get boostSupported() {
        return this.boostPath !== null;
    }

    get boostEnabled() {
        if (this._asynchronous)
            return this._boostEnabled;
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
        if (this._asynchronous)
            return this._averageFrequency;
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

    /* Read once per refresh, in MHz. */
    maxFrequency() {
        return this._maxFrequency === null ? null : this._maxFrequency / 1000;
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
            governors: this.governors,
            energyPreferences: this.energyPreferences,
            boostSupported: this.boostSupported,
            maxFrequency: this.maxFrequency(),
            amdPstateStatus: this.amdPstateStatus,
            model: this.model,
        };

        if (this._asynchronous) {
            reading.governor = this._governor;
            reading.energyPreference = this._energyPreference;
            reading.boostEnabled = this._boostEnabled;
            reading.averageFrequency = this._averageFrequency;
            return reading;
        }

        /*
         * Everything above is already in hand. The four below each cost a
         * file read - the frequency one per policy, which is 32 of them on a
         * sixteen core machine - and every one of them can be displayed
         * nowhere: the governor only in the menu and the tooltip, the energy
         * preference and the boost state only in the menu, the frequency only
         * where the panel was asked for it.
         *
         * So they are worked out when somebody asks. With the menu shut and
         * the pointer elsewhere - which is nearly always - a poll now reads
         * no cpufreq node at all, and the values that are read are read at
         * the moment they are shown rather than up to four seconds before.
         */
        _lazy(reading, "governor", () => this.governor);
        _lazy(reading, "energyPreference", () => this.energyPreference);
        _lazy(reading, "boostEnabled", () => this.boostEnabled);
        _lazy(reading, "averageFrequency", () => this.averageFrequency());
        return reading;
    }

    destroy() {
        this._destroyed = true;
        this._stateGeneration++;
        this._refreshPending = false;
        this._refreshWaiters = [];
    }
};
