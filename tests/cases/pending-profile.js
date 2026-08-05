/*
 * The profile that has been asked for and has not arrived.
 *
 * Three flags and a rule about each, which used to live across the five places
 * in applet.js that ask for a profile, draw one or step to the next - and had
 * two faults at once for it. Both are cases here.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Pending = Harness.requireXlet("./lib/pending-profile.js");

/* One request, plus whatever it reported when it gave up on it. */
function pending() {
    let lapses = [];
    let profile = new Pending.PendingProfile((asked, actual) => lapses.push([asked, actual]));
    profile.lapses = lapses;
    return profile;
}

/* A request that has been written and then ignored for as long as it takes. */
function waitOut(profile, active) {
    for (let i = 0; i < Pending.READINGS_BEFORE_LAPSING; i++)
        profile.settle(active);
}

var cases = {};

cases["nothing is pending to begin with"] = function () {
    Harness.equal(pending().value, null, "so the panel draws what the reading says");
};

cases["what was asked for is what is drawn"] = function () {
    let profile = pending();
    Harness.equal(profile.ask("performance"), true, "a new request");
    Harness.equal(profile.value, "performance",
                  "and it is drawn at once, rather than a poll later");
};

cases["asking again for the one in flight is not a change"] = function () {
    let profile = pending();
    profile.ask("performance");
    Harness.equal(profile.ask("performance"), false,
                  "or a click on a filled segment writes a second time");
    Harness.equal(profile.value, "performance", "and it is still the one being drawn");
};

cases["the machine catching up ends it"] = function () {
    let profile = pending();
    profile.ask("performance");
    profile.written("performance");

    profile.settle("balanced");
    Harness.equal(profile.value, "performance", "not yet");

    profile.settle("performance");
    Harness.equal(profile.value, null, "arrived, so there is nothing left to stand in for it");
    Harness.deepEqual(profile.lapses, [], "and nothing to remark on");
};

cases["a refusal ends it"] = function () {
    let profile = pending();
    profile.ask("performance");
    profile.failed("performance");
    Harness.equal(profile.value, null, "the panel goes back with the change");
};

cases["a write is pending only when its backend accepts it"] = function () {
    let profile = pending();
    let finish = null;
    let result = "not answered";
    let accepted = profile.request("performance", done => {
        finish = done;
        return true;
    }, error => { result = error; });

    Harness.equal(accepted, true, "the backend took the request");
    Harness.equal(profile.value, "performance", "so it is drawn while the write is in flight");
    finish(null);
    Harness.equal(result, null, "the successful answer reaches the caller");
    Harness.equal(profile.value, "performance", "and waits for the machine to adopt it");
};

cases["a synchronous backend refusal clears the request"] = function () {
    let profile = pending();
    let reported = null;
    let accepted = profile.request("performance", done => {
        done(new Error("daemon unavailable"));
        return false;
    }, error => { reported = error; });

    Harness.equal(accepted, false, "nothing was started");
    Harness.equal(profile.value, null, "the refused profile is not left drawn");
    Harness.equal(reported.message, "daemon unavailable", "the reason reaches the caller");
};

cases["a backend throw clears the request"] = function () {
    let profile = pending();
    let reported = null;
    let accepted = profile.request("performance", () => {
        throw new Error("transport failed");
    }, error => { reported = error; });

    Harness.equal(accepted, false, "the throwing call was not accepted");
    Harness.equal(profile.value, null, "the pending latch is cleared");
    Harness.equal(reported.message, "transport failed", "the exception becomes an ordinary refusal");
};

cases["an older call's refusal does not clear a newer request"] = function () {
    /*
     * Two profiles asked for in quick succession, and the first one's answer
     * arriving last. Clearing on it would take the panel back to a profile
     * nobody asked for and leave the newer change with nothing marking it.
     */
    let profile = pending();
    profile.ask("performance");
    profile.ask("power-saver");

    profile.failed("performance");
    Harness.equal(profile.value, "power-saver", "the newer request stands");

    profile.written("performance");
    profile.settle("balanced");
    Harness.equal(profile.value, "power-saver",
                  "and the older call cannot start its clock either");
};

cases["a write nobody has taken waits indefinitely"] = function () {
    /* A pkexec dialog can be on screen for as long as the user leaves it
     * there, and until it is answered nothing has happened yet. */
    let profile = pending();
    profile.ask("performance");

    for (let i = 0; i < 20; i++)
        profile.settle("balanced");
    Harness.equal(profile.value, "performance", "still what was asked for");
    Harness.deepEqual(profile.lapses, [], "and not yet anything to say about it");
};

cases["a write the machine never adopts lapses"] = function () {
    /*
     * The fault this exists for. Firmware that takes a platform profile and
     * reverts on its own thermal policy leaves the panel drawing a profile the
     * machine is not in - and, because asking again reads as a duplicate, that
     * profile could not be asked for again for the rest of the session.
     */
    let profile = pending();
    profile.ask("performance");
    profile.written("performance");

    waitOut(profile, "balanced");
    Harness.equal(profile.value, null, "the machine is taken at its word");
    Harness.deepEqual(profile.lapses, [["performance", "balanced"]],
                      "and it is worth a line in the log, since nothing else says so");

    Harness.equal(profile.ask("performance"), true, "and it can be asked for again");
};

cases["the count starts when the write is taken, not when it is asked for"] = function () {
    let profile = pending();
    profile.ask("performance");

    /* Readings while the dialog is up must not spend the allowance. */
    waitOut(profile, "balanced");
    profile.written("performance");
    Harness.equal(profile.value, "performance", "still pending");

    waitOut(profile, "balanced");
    Harness.equal(profile.value, null, "and only now has it waited long enough");
};

cases["a new request starts its own clock"] = function () {
    let profile = pending();
    profile.ask("performance");
    profile.written("performance");
    profile.settle("balanced");
    profile.settle("balanced");

    profile.ask("power-saver");
    profile.written("power-saver");
    profile.settle("balanced");
    Harness.equal(profile.value, "power-saver",
                  "the readings the one before it spent are not charged to this one");
};

cases["whatever order the answers arrive in, the state stays honest"] = function () {
    /*
     * This class exists because three flags and a rule about each were spread
     * over five places, and two of them were wrong: an error arriving for an
     * older request cleared a newer one, and nothing at all cleared a request
     * the machine simply never adopted.
     *
     * Both faults were orderings. So the property is about orderings: whatever
     * sequence of asks, answers and readings arrives, what is drawn is either
     * a profile somebody asked for or the truth - never a profile nobody asked
     * for, and never a request that outlives the count it is allowed.
     */
    let names = ["power-saver", "balanced", "performance", "quiet"];

    Fuzz.forAll({ what: "the pending profile", runs: 500 }, random => {
        let steps = [];
        let count = random.between(1, 12);
        for (let i = 0; i < count; i++) {
            steps.push({
                what: random.pick(["ask", "written", "failed", "settle"]),
                name: random.pick(names),
            });
        }
        return steps;
    }, steps => {
        let lapses = [];
        let pending = new Pending.PendingProfile((asked, actual) =>
            lapses.push([asked, actual]));
        let asked = [];

        for (let step of steps) {
            if (step.what === "ask") {
                if (Fuzz.answers(() => pending.ask(step.name)))
                    asked.push(step.name);
            } else if (step.what === "written") {
                Fuzz.answers(() => pending.written(step.name));
            } else if (step.what === "failed") {
                Fuzz.answers(() => pending.failed(step.name));
            } else {
                Fuzz.answers(() => pending.settle(step.name));
            }

            let value = pending.value;
            if (value !== null && asked.indexOf(value) < 0)
                throw new Error("drawing " + value + ", which nobody asked for");
        }

        for (let [lapsed] of lapses) {
            if (asked.indexOf(lapsed) < 0)
                throw new Error("lapsed " + lapsed + ", which nobody asked for");
        }
    });
};

cases["a request the machine never adopts is given up on, and only then"] = function () {
    /*
     * The count is what stops a profile being drawn for the rest of the
     * session by firmware that takes a platform profile and quietly reverts
     * to its own thermal policy. It starts only once the write came back
     * accepted, because until then nothing has happened yet and a password
     * dialog can be on screen for as long as it likes.
     */
    let lapses = [];
    let pending = new Pending.PendingProfile((asked, actual) => lapses.push([asked, actual]));

    pending.ask("performance");
    for (let i = 0; i < 20; i++)
        pending.settle("balanced");
    Harness.equal(pending.value, "performance",
                  "not written yet, so nothing has happened to give up on");
    Harness.deepEqual(lapses, [], "and nothing was said");

    pending.written("performance");
    pending.settle("balanced");
    Harness.equal(pending.value, "performance", "one reading is not long enough");
    pending.settle("balanced");
    Harness.equal(pending.value, "performance", "nor two");
    pending.settle("balanced");
    Harness.equal(pending.value, null, "the third gives up");
    Harness.deepEqual(lapses, [["performance", "balanced"]],
                      "saying what was asked for and what the machine is actually on");
};

cases["the machine catching up clears the request at once"] = function () {
    let pending = new Pending.PendingProfile(() => {});
    pending.ask("performance");
    pending.written("performance");
    pending.settle("performance");
    Harness.equal(pending.value, null, "arrived, so there is nothing pending");
};

cases["an answer for a request that has been replaced is ignored"] = function () {
    /*
     * A second profile asked for while the first is in flight, and then the
     * first one's answer arrives. It must not touch the newer request - which
     * is the fault this class was written for.
     */
    let pending = new Pending.PendingProfile(() => {});
    pending.ask("performance");
    pending.ask("power-saver");

    pending.failed("performance");
    Harness.equal(pending.value, "power-saver", "the older failure did not clear the newer ask");

    pending.written("performance");
    pending.settle("balanced");
    pending.settle("balanced");
    pending.settle("balanced");
    Harness.equal(pending.value, "power-saver",
                  "nor did the older write start the newer one's clock");
};
