/* The wheel counts, and the count is applied once it settles. */

const Harness = imports.harness;

const ScrollGatherer = Harness.requireXlet("./lib/scroll-gatherer.js");

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
    state.settle = function () {
        let ids = Object.keys(state.pending);
        Harness.equal(ids.length, 1, "exactly one settle window is open");
        let callback = state.pending[ids[0]];
        delete state.pending[ids[0]];
        callback();
    };
    return state;
}

function gatherer(clock, options) {
    options = options || {};
    options.timers = clock;
    return new ScrollGatherer.ScrollGatherer(options);
}

var cases = {};

cases["a flick reaches the control as one step count"] = function () {
    let clock = timers();
    let applied = [];
    let scroll = gatherer(clock, { apply: steps => applied.push(steps) });

    scroll.gather(1);
    scroll.gather(1);
    scroll.gather(1);
    Harness.deepEqual(applied, [], "nothing is applied while the wheel is moving");
    Harness.deepEqual(clock.removed, [1, 2], "each notch restarts the settle window");

    clock.settle();
    Harness.deepEqual(applied, [3], "the settled flick is one change of three steps");
};

cases["a flick that cancels itself out changes nothing"] = function () {
    let clock = timers();
    let applied = [];
    let scroll = gatherer(clock, { apply: steps => applied.push(steps) });

    scroll.gather(1);
    scroll.gather(-1);
    clock.settle();
    Harness.deepEqual(applied, [], "no steps is not a change worth making");
};

cases["fractions of a notch are rounded the same way in both directions"] = function () {
    let clock = timers();
    let applied = [];
    let scroll = gatherer(clock, { apply: steps => applied.push(steps) });

    scroll.gather(0.5);
    scroll.gather(0.1);
    clock.settle();
    scroll.gather(-0.5);
    scroll.gather(-0.1);
    clock.settle();
    Harness.deepEqual(applied, [1, -1], "a flick down is as many steps as the same flick up");
};

cases["the settle window is the caller's to set"] = function () {
    let clock = timers();
    let scroll = gatherer(clock, { settleMs: 40 });
    scroll.gather(1);
    Harness.deepEqual(clock.delays, [40], "the given window is the one armed");

    let standard = gatherer(timers());
    Harness.equal(ScrollGatherer.SETTLE_MS, 250, "and the default is a quarter of a second");
    standard.cancel();
};

cases["a gathered flick that never settles is dropped at teardown"] = function () {
    let clock = timers();
    let applied = [];
    let scroll = gatherer(clock, { apply: steps => applied.push(steps) });

    scroll.gather(3);
    scroll.cancel();
    Harness.deepEqual(clock.removed, [1], "the owned timer is released");
    Harness.deepEqual(Object.keys(clock.pending), [], "and nothing is left armed");

    scroll.gather(1);
    clock.settle();
    Harness.deepEqual(applied, [1], "the dropped notches are not applied to the next flick");
};

cases["a timer already released cannot fail a teardown"] = function () {
    let scroll = new ScrollGatherer.ScrollGatherer({
        timers: {
            add: () => 5,
            remove: () => { throw new Error("already removed"); },
        },
    });
    scroll.gather(1);
    scroll.cancel();
    scroll.cancel();
};

cases["a gatherer with no action still settles"] = function () {
    let clock = timers();
    let scroll = gatherer(clock);
    scroll.gather(2);
    clock.settle();
    Harness.deepEqual(Object.keys(clock.pending), [], "the window closed on its own");
};
