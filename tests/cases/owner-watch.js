/* Recoverable ownership wiring shared by the D-Bus clients. */

const Harness = imports.harness;

const Log = Harness.requireXlet("./lib/log.js");
const OwnerWatch = Harness.requireXlet("./lib/owner-watch.js");

function timers() {
    let state = { next: 1, pending: {}, delays: [], removed: [] };
    state.add = function (delay, callback) {
        let id = state.next++;
        state.pending[id] = callback;
        state.delays.push(delay);
        return id;
    };
    state.remove = function (id) {
        state.removed.push(id);
        delete state.pending[id];
    };
    state.fire = function () {
        let ids = Object.keys(state.pending);
        Harness.equal(ids.length, 1, "one ownership retry is pending");
        let callback = state.pending[ids[0]];
        delete state.pending[ids[0]];
        callback();
    };
    return state;
}

var cases = {};

cases["a failed owner watch retries with bounded diagnostics and backoff"] = function () {
    let clock = timers();
    let lines = [];
    let attempts = 0;
    let appeared = 0;
    let released = [];
    Log.setSink(line => lines.push(line));
    try {
        let watch = new OwnerWatch.ResilientOwnerWatch({
            install: onAppeared => {
                attempts++;
                if (attempts < 4)
                    throw new Error("bus unavailable");
                onAppeared();
                return 42;
            },
            release: id => released.push(id),
            appeared: () => appeared++,
            failureMessage: "cannot watch example service",
            timers: clock,
            retryInitialMs: 5,
            retryMaxMs: 10,
        });

        Harness.equal(watch.start(), false, "the first registration fails safely");
        clock.fire();
        clock.fire();
        Harness.deepEqual(clock.delays, [5, 10, 10], "retry delay stops at its cap");
        Harness.equal(lines.length, 1, "one continuous setup failure is logged once");
        clock.fire();
        Harness.equal(watch.active, true, "a later registration recovers the edge");
        Harness.equal(appeared, 1, "its synchronous initial state is preserved");
        Harness.equal(Object.keys(clock.pending).length, 0, "recovery leaves no timer");
        watch.stop();
        Harness.deepEqual(released, [42], "teardown releases the recovered watch");
    } finally {
        Log.setSink(null);
    }
};

cases["teardown cancels an owner watch retry"] = function () {
    let clock = timers();
    let attempts = 0;
    let watch = new OwnerWatch.ResilientOwnerWatch({
        install: () => { attempts++; throw new Error("offline"); },
        timers: clock,
    });
    Log.setSink(() => {});
    try {
        watch.start();
        watch.stop();
    } finally {
        Log.setSink(null);
    }
    Harness.equal(attempts, 1, "no retry ran during teardown");
    Harness.equal(Object.keys(clock.pending).length, 0, "the timer was removed");
    Harness.deepEqual(clock.removed, [1], "the owned timer is released once");
};

cases["the default GLib retry timer is owned and cannot be duplicated"] = function () {
    let watch = new OwnerWatch.ResilientOwnerWatch({
        install: () => { throw new Error("offline"); },
    });
    Log.setSink(() => {});
    try {
        Harness.equal(watch.start(), false, "the failed registration arms its fallback timer");
        watch._scheduleRetry();
        Harness.equal(watch.active, false, "a pending retry is not an installed watch");
        watch.stop();
    } finally {
        Log.setSink(null);
    }
};
