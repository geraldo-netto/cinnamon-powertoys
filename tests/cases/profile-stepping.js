/*
 * One step along the list of power profiles.
 *
 * The wheel, the middle click and the hotkey all did this on the applet, so
 * the one thing they have in common - stepping from what has been asked for
 * rather than from what has arrived - could only be checked by cutting the
 * method out of the source with a regular expression. It is a library, and
 * these are cases against it.
 */

const Harness = imports.harness;

const Backends = Harness.requireXlet("./lib/backends.js");
const ProfileSelection = Harness.requireXlet("./lib/profile-selection.js");
const ProfileStepping = Harness.requireXlet("./lib/profile-stepping.js");

var cases = {};

function rig(options) {
    options = options || {};
    let log = { writes: [], results: [], notified: [] };
    let daemon = { available: true, setProfile: () => true };
    let firmware = { available: false, setProfile: () => true };
    let selection = new ProfileSelection.ProfileSelection(daemon, firmware,
                                                          function () {});
    selection.choose();
    log.selection = selection;
    log.daemon = daemon;
    log.firmware = firmware;
    log.pending = options.pending !== undefined ? options.pending : null;
    log.reading = options.reading !== undefined ? options.reading : {
        profile: {
            available: true,
            list: ["power-saver", "balanced", "performance"],
            active: "balanced",
            source: daemon,
            generation: selection.generation,
        },
    };
    let stepper = new ProfileStepping.ProfileStepper({
        reading: () => log.reading,
        pending: () => log.pending,
        selection: selection,
        platformProfiles: firmware,
        helper: options.helper || { busy: false },
        privileged: () => options.privileged !== false,
        setProfile: (name, onResult) => {
            log.writes.push(name);
            log.results.push(onResult);
            return options.accepts !== false;
        },
        notifications: {
            notify: (title, body) => log.notified.push([title, body]),
        },
    });
    return { stepper: stepper, log: log };
}

cases["there is nothing to step before the first reading"] = function () {
    let it = rig({ reading: null });
    Harness.equal(it.stepper.state(), null, "no reading, no steppable block");
    Harness.equal(it.stepper.step(1, true, true), false, "and the wheel does nothing");
    Harness.equal(it.log.writes.length, 0, "without asking for a write");
};

cases["a profile block with no profiles in it is not steppable"] = function () {
    let it = rig();
    it.log.reading = { profile: { available: true, list: [], source: it.log.daemon } };
    Harness.equal(it.stepper.state(), null, "an empty list cannot be stepped along");
};

cases["controls from a previous owner are refused"] = function () {
    let it = rig();
    Harness.ok(it.stepper.state(), "the current owner's block steps");
    it.log.firmware.available = true;
    it.log.daemon.available = false;
    it.log.selection.choose();
    Harness.equal(it.stepper.state(), null,
                  "a block the previous writer produced is not stepped against the new one");
};

cases["a firmware profile is gated while the helper is busy"] = function () {
    let helper = { busy: false };
    let it = rig({ helper: helper });
    it.log.daemon.available = false;
    it.log.firmware.available = true;
    it.log.selection.choose();
    it.log.reading = {
        profile: {
            available: true,
            list: ["low-power", "balanced", "performance"],
            active: "balanced",
            source: it.log.firmware,
            generation: it.log.selection.generation,
        },
    };
    Harness.ok(it.stepper.state(), "the firmware block steps while nothing else is writing");
    helper.busy = true;
    Harness.equal(it.stepper.state(), null,
                  "and not while a password dialog is already up for another change");
};

cases["a daemon profile is not gated by the helper at all"] = function () {
    let it = rig({ helper: { busy: true } });
    Harness.ok(it.stepper.state(),
               "the daemon is unprivileged, so a busy helper is none of its business");
};

cases["privileged controls turned off stop the wheel where they stop the menu"] = function () {
    let it = rig({ privileged: false });
    it.log.daemon.available = false;
    it.log.firmware.available = true;
    it.log.selection.choose();
    it.log.reading = {
        profile: {
            available: true,
            list: ["low-power", "balanced"],
            active: "balanced",
            source: it.log.firmware,
            generation: it.log.selection.generation,
            backend: Backends.PLATFORM_BACKEND,
        },
    };
    Harness.equal(it.stepper.state(), null, "the firmware write needs a permission nobody gave");
};

cases["a step lands on the next profile along"] = function () {
    let it = rig();
    Harness.equal(it.stepper.step(1, false, false), true, "the step was accepted");
    Harness.deepEqual(it.log.writes, ["performance"], "one past the active one");
};

cases["a step off the end of the list without wrapping does nothing"] = function () {
    let it = rig();
    it.log.reading.profile.active = "performance";
    Harness.equal(it.stepper.step(1, false, false), false, "the wheel stops at the end");
    Harness.equal(it.log.writes.length, 0, "rather than coming round again");
};

cases["a cycle wraps and announces"] = function () {
    let it = rig();
    it.log.reading.profile.active = "performance";
    Harness.equal(it.stepper.cycle(), true, "the cycle wraps round the end");
    Harness.deepEqual(it.log.writes, ["power-saver"], "to the first profile again");
    it.log.results.shift()(null);
    Harness.equal(it.log.notified.length, 1,
                  "and says so, because nothing else necessarily shows it");
};

cases["the step is taken from what was asked for, not from what arrived"] = function () {
    let it = rig();
    /* A firmware change is pending behind a password dialog: the machine still
     * reports balanced and will until the dialog is answered. */
    it.log.pending = "performance";
    Harness.equal(it.stepper.shown(), "performance", "the shown profile is the asked-for one");
    Harness.equal(it.stepper.step(-1, false, false), true, "a step back is accepted");
    Harness.deepEqual(it.log.writes, ["balanced"],
                      "one back from what was asked for, not from what the machine reports");
};

cases["a step the writer would not take is not announced"] = function () {
    let it = rig({ accepts: false });
    Harness.equal(it.stepper.step(1, true, true), false, "a refused write is a refused step");
    Harness.equal(it.log.notified.length, 0, "and announces nothing");
};

cases["acceptance is not success and is not announced as one"] = function () {
    let it = rig();
    Harness.equal(it.stepper.step(1, false, true), true, "the write was taken");
    Harness.deepEqual(it.log.notified, [], "which is not the same as it having happened");
    it.log.results.shift()(new Error("authentication cancelled"));
    Harness.deepEqual(it.log.notified, [], "and a failure announces nothing either");

    it.stepper.step(1, false, true);
    it.log.results.shift()(null);
    Harness.equal(it.log.notified.length, 1, "only the matching success is announced");
    Harness.equal(it.log.notified[0][0], "Power Toys", "under the applet's own name");
};

cases["a step nobody asked to hear about stays quiet"] = function () {
    let it = rig();
    it.stepper.step(1, false, false);
    it.log.results.shift()(null);
    Harness.deepEqual(it.log.notified, [],
                      "the menu segment filling under the click is its own announcement");
};

cases["a stepper with no ports at all does not throw"] = function () {
    let stepper = new ProfileStepping.ProfileStepper();
    Harness.equal(stepper.state(), null, "there is no reading to step");
    Harness.equal(stepper.step(1, true, true), false, "so no step is taken");
    Harness.equal(stepper.cycle(), false, "and no cycle either");
    Harness.equal(stepper.context().backend, null, "with no writer to name");
};
