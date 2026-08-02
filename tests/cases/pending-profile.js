/*
 * The profile that has been asked for and has not arrived.
 *
 * Three flags and a rule about each, which used to live across the five places
 * in applet.js that ask for a profile, draw one or step to the next - and had
 * two faults at once for it. Both are cases here.
 */

const Harness = imports.harness;

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
