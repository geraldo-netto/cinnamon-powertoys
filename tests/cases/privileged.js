/*
 * Running the privileged helper.
 *
 * The spawn is a parameter, so nothing here launches pkexec, asks for a
 * password or writes to /sys. What is checked is which helper gets picked,
 * what is handed to pkexec, and how each way the helper can end is reported.
 */

const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const SYSTEM = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";
const OWN = "/home/someone/.local/share/cinnamon/applets/x/powertoys-helper";

/* Builds a helper over a pretend file system and a pretend pkexec. */
function helperWith(present, answer) {
    let repaired = [];
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM, OWN],
        path => present.indexOf(path) >= 0,
        path => repaired.push(path),
        function (argv, onDone) {
            spawned.push(argv.join(" "));
            onDone(answer[0], answer[1]);
        });
    helper.repaired = repaired;
    helper.spawned = spawned;
    return helper;
}

var cases = {};

cases["the root owned helper is preferred"] = function () {
    let helper = helperWith([SYSTEM, OWN], [0, ""]);
    Harness.equal(helper.path(), SYSTEM, "the one the polkit action names");
    Harness.deepEqual(helper.repaired, [],
                      "and it is not ours to chmod, so it is left alone");
};

cases["without it, the applet's own copy is used and repaired"] = function () {
    let helper = helperWith([OWN], [0, ""]);
    Harness.equal(helper.path(), OWN, "ours");
    Harness.deepEqual(helper.repaired, [OWN],
                      "a checkout or a zip download can lose the executable bit");
};

cases["with no helper at all, nothing is spawned"] = function () {
    let helper = helperWith([], [0, ""]);
    let outcome = null;
    helper.run(["governor", "powersave"], result => { outcome = result; });
    Harness.equal(helper.path(), null, "none found");
    Harness.deepEqual(helper.spawned, [], "and pkexec was never asked");
    Harness.equal(outcome.applied, false, "reported as not applied");
    Harness.ok(outcome.error, "with a reason");
};

cases["the command is handed to pkexec as it stands"] = function () {
    let helper = helperWith([SYSTEM], [0, ""]);
    helper.run(["charge-threshold", 80], () => {});
    Harness.deepEqual(helper.spawned, ["pkexec " + SYSTEM + " charge-threshold 80"],
                      "arguments, not a shell line");
};

cases["a helper that succeeds reports applied"] = function () {
    let helper = helperWith([SYSTEM], [0, ""]);
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });
    Harness.equal(outcome.applied, true, "applied");
    Harness.equal(outcome.cancelled, undefined, "not cancelled");
    Harness.equal(outcome.error, undefined, "no error");
};

cases["a dismissed password dialog is cancelled, not an error"] = function () {
    for (let status of [126, 127]) {
        let helper = helperWith([SYSTEM], [status, ""]);
        let outcome = null;
        helper.run(["governor", "powersave"], result => { outcome = result; });
        Harness.equal(outcome.applied, false, "status " + status + ": not applied");
        Harness.equal(outcome.cancelled, true,
                      "status " + status + ": the user already knows nothing happened");
    }
};

cases["the helper's own last word becomes the reason"] = function () {
    let helper = helperWith([SYSTEM], [1,
        "powertoys-helper: no cpufreq policy found\npowertoys-helper: unknown governor: nonsense\n"]);
    let outcome = null;
    helper.run(["governor", "nonsense"], result => { outcome = result; });
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.cancelled, undefined, "not cancelled either");
    Harness.equal(outcome.error, "unknown governor: nonsense",
                  "the last line, without the script's own name in front of it");
};

cases["a failure with nothing to say still reports a failure"] = function () {
    let helper = helperWith([SYSTEM], [1, ""]);
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.error, "", "with no reason to give, which the caller words itself");
};

/* A helper whose spawn is held open until the case says to answer. */
function deferredHelper() {
    let waiting = [];
    let helper = new Privileged.PrivilegedHelper([SYSTEM], () => true, () => {},
                                                 (argv, onDone) => waiting.push({ argv: argv, onDone: onDone }));
    helper.waiting = waiting;
    helper.answer = function (status) {
        let next = waiting.shift();
        next.onDone(status === undefined ? 0 : status, "");
    };
    return helper;
}

cases["two changes at once are one dialog after another"] = function () {
    let helper = deferredHelper();
    let finished = [];
    helper.run(["governor", "powersave"], () => finished.push("governor"));
    helper.run(["epp", "power"], () => finished.push("epp"));

    Harness.equal(helper.waiting.length, 1, "only the first was spawned");
    Harness.equal(helper.busy, true, "and it says so");

    helper.answer(0);
    Harness.deepEqual(finished, ["governor"], "the first is done");
    Harness.equal(helper.waiting.length, 1, "and now the second is running");

    helper.answer(0);
    Harness.deepEqual(finished, ["governor", "epp"], "in the order they were asked for");
    Harness.equal(helper.busy, false, "and nothing is left");
};

cases["a refused change does not strand the one behind it"] = function () {
    let helper = deferredHelper();
    let outcomes = [];
    helper.run(["governor", "powersave"], result => outcomes.push(result));
    helper.run(["boost", "1"], result => outcomes.push(result));

    helper.answer(126);
    helper.answer(0);
    Harness.equal(outcomes[0].cancelled, true, "the first was dismissed");
    Harness.equal(outcomes[1].applied, true, "the second still ran");
};

cases["nothing in flight means not busy"] = function () {
    let helper = helperWith([SYSTEM], [0, ""]);
    Harness.equal(helper.busy, false, "before");
    helper.run(["boost", "1"], () => {});
    Harness.equal(helper.busy, false, "and after, since that spawn answered at once");
};
