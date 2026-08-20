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

cases["one timer port adapts each convention a backend already has"] = function () {
    let calls = [];
    let camel = OwnerWatch.timerPort({
        timeoutAdd: (delay, callback) => { calls.push(["camel", delay, callback]); return 7; },
        removeTimer: id => calls.push(["camel-remove", id]),
    });
    let snake = OwnerWatch.timerPort({
        timeout_add: (priority, delay, callback) => {
            calls.push(["snake", delay, callback]);
            return 8;
        },
        source_remove: id => calls.push(["snake-remove", id]),
    });
    let port = OwnerWatch.timerPort({
        add: (delay, callback) => { calls.push(["port", delay, callback]); return 9; },
        remove: id => calls.push(["port-remove", id]),
    });
    let noop = () => {};

    Harness.equal(camel.add(5, noop), 7, "a bus-shaped source keeps its id");
    Harness.equal(snake.add(6, noop), 8, "a GLib-shaped source keeps its id");
    Harness.equal(port.add(7, noop), 9, "an already-shaped port is passed through");
    camel.remove(7);
    snake.remove(8);
    port.remove(9);

    /* Nothing to adapt: GLib's own main loop, which is what every production
     * caller gets. A zero delay is armed and released without ever firing, so
     * the case does not wait on a clock. */
    let fallback = OwnerWatch.timerPort();
    let msId = fallback.add(0, () => false);
    Harness.ok(msId > 0, "the millisecond timer is GLib's");
    fallback.remove(msId);
    let slow = OwnerWatch.timerPort(null, { seconds: true });
    let secondsId = slow.add(0, () => false);
    Harness.ok(secondsId > 0, "and a delay counted in seconds is its second-resolution one");
    Harness.ok(secondsId !== msId, "which is a timer of its own");
    slow.remove(secondsId);
    Harness.deepEqual(calls.map(call => call[0]), [
        "camel", "snake", "port", "camel-remove", "snake-remove", "port-remove",
    ], "each convention reaches its own timer");
    Harness.deepEqual(calls.slice(0, 3).map(call => call[1]), [5, 6, 7],
        "the delay is passed on unchanged");
};

cases["watchOwnership retries through a backend's own timers"] = function () {
    let clock = timers();
    let attempts = 0;
    let watch = OwnerWatch.watchOwnership({
        install: () => {
            attempts++;
            if (attempts < 2)
                throw new Error("offline");
            return 3;
        },
        timers: {
            timeoutAdd: (delay, callback) => clock.add(delay, callback),
            removeTimer: id => clock.remove(id),
        },
        retryInitialMs: 5,
    });
    Log.setSink(() => {});
    try {
        Harness.equal(watch.start(), false, "the first registration fails safely");
        Harness.deepEqual(clock.delays, [5], "the retry was armed on the injected timer");
        clock.fire();
        Harness.equal(watch.active, true, "the retry installed the watch");
        watch.stop();
    } finally {
        Log.setSink(null);
    }
};
