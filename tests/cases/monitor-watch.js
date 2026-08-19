/*
 * When a monitor on a cable is worth looking for, and how often.
 *
 * These are the cases the applet could not have: the state machine used to be
 * seven methods and four fields on the coordinator, where the only way to move
 * the lid, answer for the settings daemon or tick the probe timer was a running
 * Cinnamon with a monitor on it.
 */

const Harness = imports.harness;

const MonitorWatch = Harness.requireXlet("./lib/monitor-watch.js");

function timers() {
    let state = { next: 1, pending: {}, intervals: [], removed: [] };
    state.add = function (seconds, callback) {
        let id = state.next++;
        state.pending[id] = callback;
        state.intervals.push(seconds);
        return id;
    };
    state.remove = function (id) {
        state.removed.push(id);
        delete state.pending[id];
    };
    state.armed = function () {
        return Object.keys(state.pending).length;
    };
    state.tick = function () {
        for (let id of Object.keys(state.pending))
            state.pending[id]();
    };
    return state;
}

/* A watch with the machine described by `options`: `enabled` is the setting,
 * and the probes and scope changes it asks for are recorded. */
function watcher(options) {
    options = options || {};
    let state = {
        clock: timers(),
        probes: 0,
        scope: [],
        enabled: options.enabled !== false,
    };
    state.watch = new MonitorWatch.MonitorWatch({
        enabled: () => state.enabled,
        onProbe: () => { state.probes++; },
        onScopeChanged: wanted => state.scope.push(wanted),
        timers: state.clock,
    });
    if (options.kernelBacklight !== undefined)
        state.watch.setKernelBacklightState(options.kernelBacklight);
    if (options.lidClosed !== undefined)
        state.watch.setLidClosed(options.lidClosed);
    return state;
}

var cases = {};

cases["a laptop with its lid open never goes near the I2C bus"] = function () {
    let state = watcher({ kernelBacklight: "present" });

    Harness.equal(state.watch.canProbe, false,
                  "a usable built-in panel keeps DDC off the machine");
    state.watch.watch("menu", true);
    Harness.equal(state.probes, 0, "an open menu is not a reason on its own");
    Harness.equal(state.clock.armed(), 0,
                  "no timer exists whose every tick would do nothing");
};

cases["a machine with no backlight of its own probes while the menu is open"] = function () {
    let state = watcher({ kernelBacklight: "absent" });

    state.watch.watch("menu", true);
    Harness.equal(state.probes, 1, "the first look goes out at once, not a second later");
    Harness.equal(state.clock.armed(), 1, "and the recurring timer is armed");

    state.clock.tick();
    state.clock.tick();
    Harness.equal(state.probes, 3, "each tick is another look");

    state.watch.watch("menu", false);
    Harness.equal(state.clock.armed(), 0, "the timer does not outlive the open menu");
    Harness.equal(state.probes, 3, "and closing is not a reason to look");
};

cases["the setting alone stops the search"] = function () {
    let state = watcher({ kernelBacklight: "absent" });
    state.watch.watch("menu", true);
    Harness.equal(state.clock.armed(), 1, "probing while the setting is on");

    state.enabled = false;
    state.watch.syncScope();
    Harness.deepEqual(state.scope, [false],
                      "the control is told to let go of the monitors it found");
    Harness.equal(state.clock.armed(), 0, "and the timer goes with it");

    state.enabled = true;
    state.watch.syncScope();
    Harness.deepEqual(state.scope, [false, true], "switching it back on reaches the control");
    Harness.equal(state.clock.armed(), 1, "and the menu is still open, so probing resumes");
};

cases["a hover is worth one look and not a stream of them"] = function () {
    let state = watcher({ kernelBacklight: "absent" });

    state.watch.watch("tooltip", true);
    Harness.equal(state.probes, 1, "a warm-up probe makes a later menu open current");
    Harness.equal(state.clock.armed(), 0,
                  "an accidental hover does not become recurring I2C traffic");

    state.watch.watch("tooltip", true);
    Harness.equal(state.probes, 1, "the same hover reported twice is still one hover");

    state.watch.watch("menu", true);
    Harness.equal(state.probes, 2, "the menu opening is the reason that owns the timer");
    Harness.equal(state.clock.armed(), 1, "which now exists");

    /* The tooltip goes away as the menu opens under the pointer. */
    state.watch.watch("tooltip", false);
    Harness.equal(state.clock.armed(), 1, "and the same person is still looking");

    state.watch.watch("tooltip", true);
    Harness.equal(state.probes, 2, "a hover while the menu is open buys nothing");
};

cases["closing the lid hands the screen to the monitors"] = function () {
    let state = watcher({ kernelBacklight: "present" });
    state.watch.watch("menu", true);
    Harness.equal(state.watch.externalDisplayMode, false, "the built-in panel is the screen");

    Harness.equal(state.watch.setLidClosed(true), true, "the lid moved");
    state.watch.syncScope();
    Harness.equal(state.watch.externalDisplayMode, true,
                  "a panel that is present but hidden is not the screen");
    Harness.deepEqual(state.scope, [true], "the control is started");
    Harness.equal(state.probes, 1, "and the menu that is open is looked at once");
    Harness.equal(state.clock.armed(), 1, "then kept up to date");

    Harness.equal(state.watch.setLidClosed(true), false,
                  "the same lid state reported twice is not a move");
};

cases["a fact that has not moved is not reported as a move"] = function () {
    let state = watcher();

    Harness.equal(state.watch.kernelBacklightState, "unknown",
                  "nothing is claimed before the settings daemon answers");
    Harness.equal(state.watch.setKernelBacklightState("absent"), true, "the daemon answered");
    Harness.equal(state.watch.setKernelBacklightState("absent"), false,
                  "and saying so again changes nothing");
    Harness.equal(state.watch.lidClosed, false, "a lid nobody has spoken about is open");
};

cases["teardown ends the probing"] = function () {
    let state = watcher({ kernelBacklight: "absent" });
    state.watch.watch("menu", true);
    Harness.equal(state.clock.armed(), 1, "probing before teardown");

    state.watch.destroy();
    Harness.equal(state.clock.armed(), 0, "the timer is owned here and released here");
    Harness.deepEqual(state.clock.removed, [1], "exactly the timer that was armed");

    state.watch.probeNow();
    state.watch.considerProbing();
    Harness.equal(state.probes, 1, "nothing probes a machine the applet has left");
    Harness.equal(state.clock.armed(), 0, "and no timer comes back");
};
