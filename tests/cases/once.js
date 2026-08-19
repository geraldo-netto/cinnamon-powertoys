/*
 * Settle exactly once.
 *
 * The rule itself is four lines, and it was written out by hand at eight
 * places before it was one function - which is why it is worth checking here
 * rather than inside each of them: a reply and a timeout racing is the case
 * every caller depends on and none of them could describe on its own.
 */

const Harness = imports.harness;

const Once = Harness.requireXlet("./lib/once.js");

var cases = {};

cases["only the first arrival is passed through"] = function () {
    let seen = [];
    let settle = Once.once((...args) => seen.push(args));

    settle("first", 1);
    settle("second", 2);
    settle();

    Harness.deepEqual(seen, [["first", 1]], "the later arrivals are dropped");
};

cases["the first caller gets the answer and the rest get nothing"] = function () {
    let settle = Once.once(() => true);
    Harness.equal(settle(), true, "the one call that ran returns what it returned");
    Harness.equal(settle(), undefined, "and a later one returns nothing, which is falsy");
};

cases["a settled callback says so before any work is done for it"] = function () {
    let settle = Once.once(() => {});
    Harness.equal(settle.called, false, "nothing has arrived yet");
    settle();
    Harness.equal(settle.called, true, "and now something has");
};

cases["a callback that throws is still settled"] = function () {
    let calls = 0;
    let settle = Once.once(() => {
        calls++;
        throw new Error("the caller exploded");
    });

    let thrown = null;
    try {
        settle();
    } catch (error) {
        thrown = error;
    }
    Harness.equal(String(thrown).indexOf("exploded") >= 0, true,
                  "the throw belongs to the caller and is not swallowed");
    settle();
    Harness.equal(calls, 1, "but the route is closed, so it cannot be run twice");
};
