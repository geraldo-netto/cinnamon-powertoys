/* The one capped-doubling retry timer the D-Bus backends recover through. */

const Harness = imports.harness;

const Backoff = Harness.requireXlet("./lib/backoff.js");

function clock() {
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
        Harness.equal(ids.length, 1, "exactly one retry is armed");
        let callback = state.pending[ids[0]];
        delete state.pending[ids[0]];
        callback();
    };
    return state;
}

var cases = {};

cases["a retry delay doubles to its ceiling and resets on cancel"] = function () {
    let timers = clock();
    let runs = 0;
    let backoff = new Backoff.Backoff({
        timers: timers,
        initialMs: 5,
        maxMs: 10,
        run: () => runs++,
    });

    Harness.equal(backoff.schedule(), true, "the first attempt arms a timer");
    Harness.equal(backoff.pending, true, "an armed retry is pending");
    Harness.equal(backoff.schedule(), false, "a second arming is refused");
    timers.fire();
    backoff.schedule();
    timers.fire();
    backoff.schedule();
    timers.fire();
    Harness.deepEqual(timers.delays, [5, 10, 10], "the delay doubles to its ceiling");
    Harness.equal(runs, 3, "each fired retry ran once");

    backoff.cancel();
    Harness.equal(backoff.delay, 5, "cancellation resets the sequence to its floor");
    Harness.equal(backoff.pending, false, "and leaves nothing armed");
};

cases["the predicate is asked before arming and again on firing"] = function () {
    let timers = clock();
    let allowed = false;
    let runs = 0;
    let backoff = new Backoff.Backoff({
        timers: timers,
        initialMs: 5,
        allow: () => allowed,
        run: () => runs++,
    });

    Harness.equal(backoff.schedule(), false, "a backend with no reason to retry arms nothing");
    Harness.deepEqual(timers.delays, [], "and consumes no timer");

    allowed = true;
    Harness.equal(backoff.schedule(), true, "a reason to retry arms one");
    allowed = false;
    timers.fire();
    Harness.equal(runs, 0, "a reason withdrawn while pending runs nothing");
    Harness.equal(backoff.pending, false, "the fired timer is released either way");
};

cases["cancelling an already released timer is not an error"] = function () {
    let backoff = new Backoff.Backoff({
        timers: {
            add: () => 11,
            remove: () => { throw new Error("already removed"); },
        },
        initialMs: 5,
    });
    backoff.schedule();
    backoff.cancel();
    Harness.equal(backoff.pending, false, "the token is dropped regardless");
};

cases["a backend keeps its own timer convention"] = function () {
    let seen = [];
    let camel = new Backoff.Backoff({
        timers: {
            timeoutAdd: (delay, callback) => { seen.push(["camel", delay]); return 1; },
            removeTimer: id => seen.push(["camel-remove", id]),
        },
        initialMs: 5,
    });
    let snake = new Backoff.Backoff({
        timers: {
            timeout_add: (priority, delay, callback) => { seen.push(["snake", delay]); return 2; },
            source_remove: id => seen.push(["snake-remove", id]),
        },
        initialMs: 7,
    });

    camel.schedule();
    snake.schedule();
    camel.cancel();
    snake.cancel();
    Harness.deepEqual(seen, [
        ["camel", 5], ["snake", 7], ["camel-remove", 1], ["snake-remove", 2],
    ], "each backend's own timer is the one used");
};
