/*
 * cinnamon-powertoys - power supply and firmware nodes.
 *
 * The battery charge limit exposed by the laptop vendor drivers, and the ACPI
 * platform profile used when power-profiles-daemon is not running. Both are
 * absent on most desktops, which is why each lookup answers null rather than
 * throwing.
 */

const Backends = require("./lib/backends.js");
const IO = require("./lib/io.js");
const Refresh = require("./lib/refresh.js");

const POWER_SUPPLY_DIR = "/sys/class/power_supply";
const PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
const PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

/* Re-exported so a caller holding this backend need not know where the name
 * is kept; the name itself lives in lib/backends.js, where a derivation can
 * reach it without requiring this module. */
const PLATFORM_BACKEND = Backends.PLATFORM_BACKEND;

function _chargeReading(values) {
    let readable = values.filter(value => value !== null);
    let agreed = readable.length === values.length && readable.length > 0 &&
                 readable.every(value => value === readable[0]);
    let incomplete = readable.length !== values.length || values.length === 0;
    let divided = !incomplete && !agreed;
    let state = "incomplete";
    if (agreed)
        state = "agreed";
    else if (divided)
        state = "divided";
    return {
        limits: values,
        limit: agreed ? readable[0] : null,
        state: state,
        agreed: agreed,
        divided: divided,
        incomplete: incomplete,
        readableCount: readable.length,
        batteryCount: values.length,
    };
}

/*
 * The charge limit, across every battery that has one.
 *
 * Every battery, not the first. The helper writes the threshold to all of
 * them - a laptop with a main battery and a bay battery wants both moved
 * together, which is what somebody picking one number from one menu means -
 * and a control that wrote two and read one would show the first battery's
 * number and call it both. So the read is the same set as the write.
 *
 * The values are sampled rather than captured once: the firmware, a vendor
 * tool or another copy of this applet can move them, and a value remembered
 * from startup would quietly disagree with the hardware.
 *
 * Writing needs root, so it goes to a runner the caller supplies - in the
 * applet, the pkexec helper - which keeps the read and the write of one
 * setting in the same place.
 *
 * Topology and values are both kept as complete cached snapshots, and
 * discovery and sampling both go through IO's Gio calls, so opening the menu
 * never asks a power-supply driver a question on Cinnamon's thread.
 */
const ChargeControl = class ChargeControl {
    constructor(runner, onChanged) {
        this.batteries = [];
        this._runner = runner || function () {};
        this._onChanged = onChanged || function () {};
        this._reading = _chargeReading([]);
        this._scope = new IO.AsyncScope();
        this._ioOptions = { scope: this._scope };
        /* One sweep at a time and one replay however many callers asked;
         * lib/refresh.js owns that, and what is here is the sweep itself. */
        this._refresh = new Refresh.Coalescer({
            sweep: done => this._sweep(done),
            onChanged: () => this._onChanged(),
        });
        this._stateGeneration = 0;
        this._destroyed = false;
    }

    get available() {
        return this.batteries.length > 0;
    }

    reading() {
        return this._reading;
    }

    get limit() {
        return this._reading.limit;
    }

    refresh(onDone) {
        this._refresh.request(onDone);
    }

    /* One walk of /sys/class/power_supply, and whether what it found differs
     * from what was there before. */
    _sweep(done) {
        IO.listDirAsync(POWER_SUPPLY_DIR, entries => {
            let typePaths = entries.map(name => POWER_SUPPLY_DIR + "/" + name + "/type");
            let thresholdPaths = entries.map(name =>
                POWER_SUPPLY_DIR + "/" + name + "/charge_control_end_threshold");
            let types = null;
            let existence = null;
            let finish = () => {
                if (types === null || existence === null)
                    return;
                let batteries = [];
                for (let name of entries) {
                    let base = POWER_SUPPLY_DIR + "/" + name;
                    let path = base + "/charge_control_end_threshold";
                    if (types[base + "/type"] === "Battery" && existence[path])
                        batteries.push({ name: name, path: path });
                }
                this._sampleBatteries(batteries, values =>
                    this._adoptRefresh(batteries, values, done));
            };
            IO.readStringsAsync(typePaths, answer => {
                types = answer;
                finish();
            }, 16, null, this._ioOptions);
            IO.pathsExistAsync(thresholdPaths, answer => {
                existence = answer;
                finish();
            }, 16, null, this._ioOptions);
        }, null, this._ioOptions);
    }

    _sampleBatteries(batteries, onDone) {
        let paths = batteries.map(battery => battery.path);
        IO.readStringsAsync(paths, values => {
            onDone(paths.map(path => IO.toNumber(values[path])));
        }, 16, null, this._ioOptions);
    }

    _adoptRefresh(batteries, values, done) {
        if (this._destroyed)
            return;
        ++this._stateGeneration;
        let previous = JSON.stringify([this.batteries, this._reading]);
        this.batteries = batteries;
        this._reading = _chargeReading(values);
        done(previous !== JSON.stringify([this.batteries, this._reading]));
    }

    sample(onDone) {
        let done = onDone || function () {};
        if (this._destroyed) {
            done(false);
            return;
        }
        let batteries = this.batteries.slice();
        let generation = this._stateGeneration;
        this._sampleBatteries(batteries, values => {
            if (this._destroyed) {
                done(false);
                return;
            }
            /* A topology refresh may have landed while these values were in
             * flight. Its complete newer snapshot wins. */
            if (generation !== this._stateGeneration ||
                    batteries.length !== this.batteries.length ||
                    batteries.some((battery, index) =>
                        battery.path !== this.batteries[index].path)) {
                done(false);
                return;
            }
            this._reading = _chargeReading(values);
            done(true);
        });
    }

    setLimit(percent, onDone) {
        this._runner(["charge-threshold", String(percent)], onDone);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._scope.cancel();
        this._refresh.stop();
        this._onChanged = function () {};
    }
};

/*
 * The ACPI platform profile, wearing the same face as PowerProfilesClient.
 *
 * The two are not alike underneath - one is a daemon on the system bus, the
 * other is two files in /sys written through a root helper - and the applet
 * used to know that, unioning their two shapes behind a flag and then reading
 * that flag back to decide how to write. Given the same surface, it does not
 * have to: it holds one of these and asks it.
 */
const PlatformProfileClient = class PlatformProfileClient {
    constructor(runner, options) {
        let configuration = options || {};
        this._runner = runner || function () {};
        this._onChanged = configuration.onChanged || function () {};
        this._profile = null;
        this._scope = new IO.AsyncScope();
        this._ioOptions = { scope: this._scope };
        this._destroyed = false;
        this._readGeneration = 0;
        this._refreshesInFlight = 0;
        this._sampleWaiters = [];
    }

    /* What the last refresh() or sample() read. The firmware moves this on
     * its own - a lid closed, a charger unplugged - and vendor tools write it
     * too, which is why the poll keeps asking. */
    _read() {
        return this._profile;
    }

    refresh(onDone) {
        let done = onDone || function () {};
        if (this._destroyed) {
            done(false);
            return;
        }
        let generation = ++this._readGeneration;
        ++this._refreshesInFlight;
        IO.readStringsAsync([PLATFORM_PROFILE, PLATFORM_PROFILE_CHOICES], values => {
            --this._refreshesInFlight;
            if (this._destroyed) {
                done(false);
                return;
            }
            if (generation !== this._readGeneration) {
                done(false);
                this._startDeferredSample();
                return;
            }
            let active = values[PLATFORM_PROFILE];
            let rawChoices = values[PLATFORM_PROFILE_CHOICES];
            let profile = active === null || rawChoices === null ? null : {
                active: active,
                choices: IO.toWords(rawChoices),
            };
            let changed = JSON.stringify(profile) !== JSON.stringify(this._profile);
            this._profile = profile;
            done(true);
            if (changed)
                this._onChanged();
            this._startDeferredSample();
        }, 2, null, this._ioOptions);
    }

    sample(onDone) {
        let done = onDone || function () {};
        if (this._destroyed) {
            done(false);
            return;
        }
        if (this._refreshesInFlight > 0) {
            this._sampleWaiters.push(done);
            return;
        }
        this._startSample([done]);
    }

    _startDeferredSample() {
        if (this._destroyed || this._refreshesInFlight > 0 ||
                this._sampleWaiters.length === 0)
            return;
        this._startSample(this._sampleWaiters.splice(0));
    }

    _startSample(waiters) {
        if (this._profile === null) {
            for (let waiter of waiters)
                waiter(true);
            return;
        }
        let profile = this._profile;
        let generation = ++this._readGeneration;
        IO.readStringsAsync([PLATFORM_PROFILE], values => {
            if (this._destroyed || generation !== this._readGeneration ||
                    profile !== this._profile) {
                for (let waiter of waiters)
                    waiter(false);
                return;
            }
            /*
             * An unreadable node is not an answer, and storing it as one is
             * worse than not sampling at all.
             *
             * IO fills a path it could not settle - a batch that was
             * cancelled, a read that timed out - with null and calls back
             * regardless; see _batchAsync. Written through, that null leaves
             * a profile list with nothing active in it, which is not a state
             * this machine can be in: the segmented control draws with no
             * segment filled and the panel gauge falls back to the plain
             * applet icon, on exactly the machines where the firmware profile
             * is the only profile there is. It heals on the next good poll,
             * having said in the meantime that the profile was unknown.
             *
             * So the last complete reading is kept and the sample reports
             * that it did not answer, which is what the identity and
             * generation guard above already does for the other two ways this
             * reply can turn out not to describe the current profile. refresh()
             * makes the same judgement about the same node.
             */
            if (values[PLATFORM_PROFILE] === null) {
                for (let waiter of waiters)
                    waiter(false);
                return;
            }
            this._profile = {
                active: values[PLATFORM_PROFILE],
                choices: profile.choices,
            };
            for (let waiter of waiters)
                waiter(true);
        }, 1, null, this._ioOptions);
    }

    get available() {
        let profile = this._read();
        return profile !== null && profile.choices.length > 0;
    }

    /* What this backend is, for a reading that wants to say where its
     * profiles came from. */
    get busName() {
        return PLATFORM_BACKEND;
    }

    get active() {
        let profile = this._read();
        return profile === null ? null : profile.active;
    }

    get profiles() {
        let profile = this._read();
        return profile === null ? [] : profile.choices;
    }

    /* The firmware says nothing about either of these; the daemon does. */
    get degraded() {
        return "";
    }

    get holds() {
        return [];
    }

    /*
     * Everything a reading asks about the profile, from one look at the
     * firmware.
     *
     * The getters above each go back to _read(), which is right when one of
     * them is what you want and wasteful when all of them are: _read() is the
     * field the last refresh() left, so what this saves is the six lookups.
     * It is the one call a poll makes.
     */
    snapshot() {
        let profile = this._read();
        return {
            available: profile !== null && profile.choices.length > 0,
            busName: this.busName,
            active: profile === null ? null : profile.active,
            profiles: profile === null ? [] : profile.choices,
            degraded: "",
            holds: [],
        };
    }

    /*
     * Writing needs root, so it goes through the same runner every other
     * privileged setting uses. The helper checks the value against the
     * firmware's own list before writing it.
     */
    setProfile(name, onResult) {
        let done = onResult || function () {};
        this._runner(["platform-profile", String(name)], outcome => {
            if (!outcome || outcome.applied)
                done(null);
            else if (outcome.cancelled)
                done(new Error("cancelled"));
            else
                done(new Error(outcome.error || "the change could not be applied"));
        });
        return true;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        ++this._readGeneration;
        this._scope.cancel();
        let waiters = this._sampleWaiters.splice(0);
        for (let waiter of waiters)
            waiter(false);
        this._onChanged = function () {};
    }
};
