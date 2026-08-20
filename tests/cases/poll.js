/*
 * The clock this applet runs on.
 *
 * All three of these were timers in applet.js, so "a poll fires a rediscovery
 * once a minute and not once a second" and "a redraw asked for four times
 * before the main loop is idle happens once" could be true of a running
 * session or of nothing.
 */

const Harness = imports.harness;

const Poll = Harness.requireXlet("./lib/poll.js");

function loop(options) {
    let state = { ticks: 0, rediscoveries: 0, timers: [], idles: [], removed: [] };
    let next = 0;
    state.poll = new Poll.Poll({
        timers: {
            add: (seconds, callback) => {
                state.timers.push({ id: ++next, seconds: seconds, fire: callback });
                return next;
            },
            remove: id => state.removed.push(id),
            idle: callback => {
                state.idles.push({ id: ++next, fire: callback });
                return next;
            },
            cancelIdle: id => state.removed.push(id),
        },
        repeat: "continue",
        once: "remove",
        rediscoverSeconds: (options || {}).rediscoverSeconds,
        onTick: () => { state.ticks++; },
        onRediscover: () => { state.rediscoveries++; },
    });
    return state;
}

/* The interval callback, once. */
function tick(state) {
    return state.timers[state.timers.length - 1].fire();
}

var cases = {};

cases["a started loop asks for one timer at the interval it was given"] = function () {
    let state = loop();
    Harness.equal(state.poll.running, false, "nothing runs before it is started");
    state.poll.start(4);
    Harness.equal(state.timers.length, 1, "one timer");
    Harness.equal(state.timers[0].seconds, 4, "at the interval asked for");
    Harness.equal(state.poll.running, true, "and the loop is running");
    Harness.equal(tick(state), "continue", "which keeps running after a tick");
    Harness.equal(state.ticks, 1, "having taken one reading");
};

cases["an interval below a second is a second"] = function () {
    let state = loop();
    state.poll.start(0);
    Harness.equal(state.timers[0].seconds, 1, "zero would be a timer that never rests");
    state.poll.start();
    Harness.equal(state.timers[1].seconds, 1, "and so would nothing at all");
};

cases["starting again replaces the timer rather than adding one"] = function () {
    let state = loop();
    state.poll.start(4);
    state.poll.start(10);
    Harness.deepEqual(state.removed, [1], "the old interval is released");
    Harness.equal(state.timers.length, 2, "and one new one takes its place");
    Harness.equal(state.timers[1].seconds, 10, "at the new interval");
};

cases["the rediscovery is on its own slower clock"] = function () {
    let state = loop({ rediscoverSeconds: 12 });
    state.poll.start(4);
    tick(state);
    tick(state);
    Harness.equal(state.rediscoveries, 0, "eight seconds is not twelve");
    Harness.equal(state.ticks, 2, "though both ticks took a reading");
    tick(state);
    Harness.equal(state.rediscoveries, 1, "and the third brings it round");
    tick(state);
    tick(state);
    Harness.equal(state.rediscoveries, 1, "the count starts again from there");
    tick(state);
    Harness.equal(state.rediscoveries, 2, "and comes round again on time");
};

cases["a rediscovery happens before the reading it shares a tick with"] = function () {
    let order = [];
    let state = loop({ rediscoverSeconds: 1 });
    state.poll = new Poll.Poll({
        timers: {
            add: (seconds, callback) => {
                state.timers.push({ seconds: seconds, fire: callback });
                return 1;
            },
            remove: function () {},
            idle: function () { return 2; },
            cancelIdle: function () {},
        },
        rediscoverSeconds: 1,
        onTick: () => order.push("tick"),
        onRediscover: () => order.push("rediscover"),
    });
    state.timers = [];
    state.poll.start(1);
    tick(state);
    Harness.deepEqual(order, ["rediscover", "tick"],
                      "the reading is taken from the machine that was just swept");
};

cases["somebody looking starts the slower count again"] = function () {
    let state = loop({ rediscoverSeconds: 12 });
    state.poll.start(4);
    tick(state);
    tick(state);
    state.poll.seen();
    tick(state);
    Harness.equal(state.rediscoveries, 0,
                  "the menu opening swept the machine, so the count starts over");
};

cases["several reasons to redraw at once are one redraw"] = function () {
    let state = loop();
    Harness.equal(state.poll.schedule(), true, "the first asks for an idle callback");
    Harness.equal(state.poll.schedule(), false, "the second finds one already asked for");
    state.poll.schedule();
    Harness.equal(state.idles.length, 1, "and there is one callback, not three");
    Harness.equal(state.idles[0].fire(), "remove", "which does not repeat");
    Harness.equal(state.ticks, 1, "one redraw happened");
    Harness.equal(state.poll.schedule(), true, "and the next reason asks again");
    Harness.equal(state.idles.length, 2, "for a callback of its own");
};

cases["teardown drops the timer and the redraw that never fired"] = function () {
    let state = loop();
    state.poll.start(4);
    state.poll.schedule();
    state.poll.destroy();
    Harness.deepEqual(state.removed, [1, 2],
                      "both the interval and the pending redraw are released");
    Harness.equal(state.poll.running, false, "with nothing left running");
    state.poll.destroy();
    Harness.deepEqual(state.removed, [1, 2], "and a second teardown releases nothing twice");
};

cases["a stop the main loop refuses is still the last tick that timer takes"] = function () {
    /*
     * The two halves of stopping a repeating source, and only one of them is
     * ours. `remove` is a call to a collaborator: GLib raises on an id it has
     * already retired, and a caller's own port can refuse for its own reasons.
     * The id is cleared before the call, so once it has refused there is
     * nothing left to reach the source with - and the callback used to answer
     * `repeat` whatever had happened since, which is a source calling _update
     * on a destroyed applet once a second for the rest of the session.
     */
    let state = loop();
    let refusing = state.poll;
    refusing._timers.remove = () => { throw new Error("no such source"); };
    refusing.start(4);
    Harness.equal(tick(state), "continue", "a live timer asks to be called again");

    refusing.destroy();
    Harness.equal(refusing.running, false, "the loop reports itself stopped");
    Harness.equal(tick(state), "remove",
                  "and the source that outlived the removal takes itself off");
    Harness.equal(state.ticks, 1, "without a reading behind it");
};

cases["a redraw the main loop will not cancel is dropped when it fires"] = function () {
    let state = loop();
    state.poll._timers.cancelIdle = () => { throw new Error("no such source"); };
    state.poll.schedule();
    state.poll.destroy();
    Harness.equal(state.idles[0].fire(), "remove",
                  "the idle that survived cancellation takes itself off");
    Harness.equal(state.ticks, 0, "and redraws nothing for an applet that has gone");
};

cases["a restarted loop retires the timer it replaced"] = function () {
    /* The generation is what ends a timer, so it has to end exactly the one
     * being replaced: a changed interval setting restarts the loop, and the
     * new timer must go on ticking. */
    let state = loop();
    state.poll.start(4);
    let first = state.timers[0];
    state.poll.start(8);
    Harness.equal(first.fire(), "remove", "the replaced timer takes itself off");
    Harness.equal(tick(state), "continue", "the one that replaced it keeps going");
    Harness.equal(state.ticks, 1, "and only the live one took a reading");
};

cases["a loop with nothing to call is not an error"] = function () {
    let poll = new Poll.Poll();
    poll.start(4);
    poll.schedule();
    poll.seen();
    poll.destroy();
    Harness.equal(poll.running, false, "a default loop has no timers to run");
};
