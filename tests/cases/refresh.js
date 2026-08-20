/*
 * One sweep at a time, one replay however many callers asked.
 *
 * This machine was written out three times, in three backends that each need a
 * filesystem to exercise. Here it needs nothing.
 */

const Harness = imports.harness;

const Refresh = Harness.requireXlet("./lib/refresh.js");

function coalescer(options) {
    let state = { sweeps: [], changes: 0, deferred: false };
    options = options || {};
    state.it = new Refresh.Coalescer({
        sweep: done => state.sweeps.push(done),
        onChanged: () => { state.changes++; },
        defer: options.defer ? () => state.deferred : undefined,
    });
    return state;
}

var cases = {};

cases["one request is one sweep"] = function () {
    let state = coalescer();
    let answers = [];
    Harness.equal(state.it.request(result => answers.push(result)), true,
                  "the request is accepted");
    Harness.equal(state.sweeps.length, 1, "and starts a sweep at once");
    Harness.equal(state.it.running, true, "which is in flight");
    state.sweeps.shift()(true);
    Harness.deepEqual(answers, [true], "the caller is told what the sweep found");
    Harness.equal(state.changes, 1, "and the change is announced");
    Harness.equal(state.it.running, false, "with nothing left in flight");
};

cases["a sweep that changed nothing is not announced"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(result => answers.push(result));
    state.sweeps.shift()(false);
    Harness.deepEqual(answers, [false], "the caller hears that nothing moved");
    Harness.equal(state.changes, 0, "and nobody is interrupted about it");
};

cases["callers arriving during a sweep are answered by the replay"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(() => answers.push("first"));
    state.it.request(() => answers.push("second"));
    state.it.request(() => answers.push("third"));
    Harness.equal(state.sweeps.length, 1, "one sweep, however many asked");
    Harness.equal(state.it.pending, true, "and one replay is owed");
    state.sweeps.shift()(false);
    Harness.deepEqual(answers, [], "nobody settles from the superseded sweep");
    Harness.equal(state.sweeps.length, 1, "which starts exactly one replay");
    state.sweeps.shift()(false);
    Harness.deepEqual(answers, ["first", "second", "third"],
                      "and the replay answers all three");
    Harness.equal(state.sweeps.length, 0, "with no third sweep");
};

cases["what a superseded sweep saw still counts"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(result => answers.push(result));
    state.it.request(result => answers.push(result));
    state.sweeps.shift()(true);
    state.sweeps.shift()(false);
    Harness.deepEqual(answers, [true, true],
                      "a change seen on the way is part of what they are told");
    Harness.equal(state.changes, 1, "and it is announced once");
};

cases["the accumulated answer does not leak into the next request"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(result => answers.push(result));
    state.sweeps.shift()(true);
    state.it.request(result => answers.push(result));
    state.sweeps.shift()(false);
    Harness.deepEqual(answers, [true, false],
                      "the second caller hears about the second sweep only");
    Harness.equal(state.changes, 1, "and only the first is announced");
};

cases["a deferred request waits for a reason that is not this machine's"] = function () {
    let state = coalescer({ defer: true });
    state.deferred = true;
    let answers = [];
    Harness.equal(state.it.request(result => answers.push(result)), true,
                  "the request is still accepted");
    Harness.equal(state.sweeps.length, 0, "but nothing starts");
    Harness.equal(state.it.pending, true, "and a sweep is owed");
    Harness.equal(state.it.resume(), false, "which cannot start while the reason stands");
    state.deferred = false;
    Harness.equal(state.it.resume(), true, "and starts when it passes");
    Harness.equal(state.sweeps.length, 1, "as one sweep");
    state.sweeps.shift()(true);
    Harness.deepEqual(answers, [true], "answering the caller that waited");
    Harness.equal(state.it.resume(), false, "with nothing owed afterwards");
};

cases["teardown answers everyone once, unsuccessfully"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(result => answers.push(result));
    state.it.request(result => answers.push(result));
    Harness.equal(state.it.stop(), null, "nothing went wrong on the way out");
    Harness.deepEqual(answers, [false, false], "both accepted callers are settled");
    Harness.equal(state.it.stop(), null, "a second teardown is not a second answer");
    Harness.deepEqual(answers, [false, false], "and settles nobody again");
    state.sweeps.shift()(true);
    Harness.deepEqual(answers, [false, false], "a cancelled sweep cannot answer either");
    Harness.equal(state.changes, 0, "and announces nothing");
};

cases["a waiter that throws on the way out does not strand the next"] = function () {
    let state = coalescer();
    let answers = [];
    state.it.request(() => { throw new Error("waiter exploded"); });
    state.it.request(result => answers.push(result));
    let error = state.it.stop();
    Harness.ok(error && String(error).indexOf("waiter exploded") >= 0,
               "the throw is handed back rather than swallowed");
    Harness.deepEqual(answers, [false], "and the waiter behind it is still settled");
};

cases["nothing is accepted after teardown"] = function () {
    let state = coalescer();
    state.it.stop();
    let answer = null;
    Harness.equal(state.it.request(result => { answer = result; }), false,
                  "the request is rejected");
    Harness.equal(answer, false, "and the caller is settled rather than left waiting");
    Harness.equal(state.sweeps.length, 0, "with no machine read");
    Harness.equal(state.it.resume(), false, "and no replay to resume");
    Harness.equal(state.it.stopped, true, "which is what stopped means");
};

cases["a sweep nobody configured still settles"] = function () {
    let it = new Refresh.Coalescer();
    let answer = null;
    it.request(result => { answer = result; });
    Harness.equal(answer, false, "a default sweep answers that nothing changed");
};

cases["a request with no caller to answer is still a sweep"] = function () {
    let state = coalescer();
    state.it.request();
    Harness.equal(state.sweeps.length, 1, "the sweep runs for its own sake");
    state.sweeps.shift()(true);
    Harness.equal(state.changes, 1, "and what it found is still announced");
};
