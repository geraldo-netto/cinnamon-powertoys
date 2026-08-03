/*
 * Running the privileged helper.
 *
 * The spawn is a parameter, so nothing here launches pkexec, asks for a
 * password or writes to /sys. What is checked is which helper gets picked,
 * what is handed to pkexec, and how each way the helper can end is reported.
 */

const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");
const Log = Harness.requireXlet("./lib/log.js");

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

cases["what is queued when the applet leaves is dropped"] = function () {
    /*
     * Everything that comes back from here checks whether the applet is still
     * on the panel, which is why this went unnoticed: a pkexec dialog is not
     * something that comes back. Left alone, the queue went on spawning them.
     */
    let helper = deferredHelper();
    let finished = [];
    helper.run(["governor", "powersave"], () => finished.push("governor"));
    helper.run(["epp", "power"], () => finished.push("epp"));
    Harness.equal(helper.waiting.length, 1, "the first is running");

    helper.destroy();
    helper.answer(0);

    Harness.deepEqual(finished, ["governor"], "the one already running still finishes");
    Harness.equal(helper.waiting.length, 0,
                  "and the second is not spawned, so no dialog for an applet that has gone");
};

cases["the change already on screen is left to finish"] = function () {
    /* Its dialog is up, the user asked for it and may be halfway through
     * typing; taking that away is worse than letting it complete. */
    let helper = deferredHelper();
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });
    helper.destroy();

    Harness.equal(helper.waiting.length, 1, "still in flight");
    helper.answer(0);
    Harness.equal(outcome.applied, true, "and it applied, as the user asked");
};

cases["nothing new is taken after that"] = function () {
    let helper = deferredHelper();
    helper.destroy();

    let outcome = null;
    helper.run(["governor", "powersave"], result => { outcome = result; });
    Harness.equal(helper.waiting.length, 0, "nothing spawned");
    Harness.equal(outcome.applied, false, "and the caller is answered rather than left waiting");
};

/* ---------------------------------------------------------------- */
/* the spawn itself                                                  */

cases["the module's own spawn runs a command and reports what it said"] = function () {
    /*
     * Every case above hands in a spawn of its own, so the one a running
     * applet actually uses - the only one there is in production - was
     * exercised by none of them. It is thirteen lines that decide what a
     * privileged change comes back as: the exit status that says applied,
     * cancelled or refused, and the stderr the reason is read out of.
     *
     * It runs real processes here, which is what makes it worth doing: they
     * are the two smallest programs on the machine, and what is checked is
     * that the status and the output arrive at all.
     */
    let ok = Harness.settle(done => Privileged._spawn(["true"], (status, stderr) =>
        done({ status: status, stderr: stderr })), "a command that succeeds");
    Harness.equal(ok.status, 0, "true succeeds");
    Harness.equal(ok.stderr, "", "and says nothing");

    let bad = Harness.settle(done => Privileged._spawn(["false"], (status, stderr) =>
        done({ status: status, stderr: stderr })), "a command that fails");
    Harness.ok(bad.status !== 0, "false does not");

    let spoken = Harness.settle(done => Privileged._spawn(
        ["sh", "-c", "echo powertoys-helper: unknown governor: nonsense >&2; exit 1"],
        (status, stderr) => done({ status: status, stderr: stderr })), "a command that complains");
    Harness.equal(spoken.status, 1, "the status it exited with");
    Harness.ok(spoken.stderr.indexOf("unknown governor") >= 0,
               "and its complaint, which is where a reason comes from: " + spoken.stderr);
};

cases["a command that cannot be run at all is a failure, not a crash"] = function () {
    /*
     * pkexec missing, or the helper deleted between the check and the spawn.
     * Gio throws where the process cannot be started, and a throw here would
     * come up through whatever the user just clicked.
     */
    let outcome = Harness.settle(done => Privileged._spawn(
        ["/definitely/not/a/program"], (status, stderr) =>
            done({ status: status, stderr: stderr })), "a program that is not there");
    Harness.equal(outcome.status, -1, "reported as a failure of its own");
    Harness.ok(outcome.stderr.length > 0, "with something to say about why");
};

cases["a real helper run reaches the outcome the menu reads"] = function () {
    /*
     * End to end through the class rather than around it: the queue, the
     * spawn, the exit status and the outcome object. What is spawned is a
     * stand-in for pkexec, since the real one would put a password dialog on
     * screen - but everything this side of it is what runs in the applet.
     */
    let helper = new Privileged.PrivilegedHelper(
        ["/bin/echo"], path => path === "/bin/echo", () => {},
        (argv, onDone) => Privileged._spawn(argv.slice(1), onDone));

    let outcome = Harness.settle(done => helper.run(["governor", "performance"], done),
                                 "a change that is applied");
    Harness.deepEqual(outcome, { applied: true }, "applied, with nothing else to say");
};

cases["what the helper prints is turned into one line of reason"] = function () {
    /* The applet shows the last line, without the helper's own name in front
     * of it: a notification saying "powertoys-helper: unknown governor" is
     * telling the user about a script they did not run. */
    let helper = new Privileged.PrivilegedHelper(
        ["/bin/sh"], () => true, () => {},
        (argv, onDone) => Privileged._spawn(
            ["sh", "-c", "echo first line >&2; echo 'powertoys-helper: no cpufreq policy found' >&2; exit 3"],
            onDone));

    let outcome = Harness.settle(done => helper.run(["governor", "x"], done), "a refusal");
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.error, "no cpufreq policy found",
                  "the last line, and not the script's name");
};

cases["a helper that prints something no text can hold is still an answer"] = function () {
    /*
     * communicate_utf8_finish throws where the output is not valid UTF-8, and
     * a helper is a shell script that can print whatever a kernel error
     * message contains. A throw there is a change that never answers: the
     * queue keeps its job, busy stays true, and every control in the menu
     * shows as in flight for the rest of the session.
     */
    let outcome = Harness.settle(done => Privileged._spawn(
        ["sh", "-c", "printf 'bad: \\377\\376' >&2; exit 1"],
        (status, stderr) => done({ status: status, stderr: stderr })),
        "a helper printing bytes that are not text");
    Harness.equal(outcome.status, -1, "reported as a failure of its own");
    Harness.ok(typeof outcome.stderr === "string", "and with something to say");
};

cases["the reason is the last line, even where there is only one"] = function () {
    /* A helper that dies on its first check prints one line, which is the
     * common case and the one a caller most wants the words of. */
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true, () => {},
        (argv, onDone) => onDone(1, "powertoys-helper: unknown governor: nonsense\n"));
    let outcome = null;
    helper.run(["governor", "nonsense"], result => { outcome = result; });
    Harness.equal(outcome.error, "unknown governor: nonsense", "one line, and it is the reason");
};

cases["a refusal is written to the log with its status and its reason"] = function () {
    /*
     * The only trace a refused change leaves. The applet turns the outcome
     * into a notification, but the status is not in that - and the status is
     * what tells a helper that was never installed from one that ran and said
     * no.
     */
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        let helper = new Privileged.PrivilegedHelper(
            [SYSTEM], () => true, () => {},
            (argv, onDone) => onDone(3, "powertoys-helper: no cpufreq policy found\n"));
        helper.run(["governor", "x"], () => {});
        Harness.equal(lines.length, 1, "one line");
        Harness.equal(lines[0],
                      "[powertoys] helper failed with status 3: no cpufreq policy found",
                      "the status and the reason, in that order");

        lines.length = 0;
        let quiet = new Privileged.PrivilegedHelper(
            [SYSTEM], () => true, () => {}, (argv, onDone) => onDone(9, ""));
        quiet.run(["boost", "1"], () => {});
        Harness.equal(lines[0], "[powertoys] helper failed with status 9: no reason given",
                      "and a helper that said nothing is said to have said nothing");
    } finally {
        Log.setSink(null);
    }
};

cases["a second change is not spawned while the first is on screen"] = function () {
    /*
     * Two pkexec at once is two password dialogs, one behind the other, for
     * two settings - and whichever is answered first, the other is still
     * waiting. The guard that prevents it is three conditions read as an
     * either-or; read as an and-both it lets everything through.
     */
    let helper = deferredHelper();
    helper.run(["governor", "powersave"], () => {});
    helper.run(["epp", "power"], () => {});
    helper.run(["boost", "1"], () => {});
    Harness.equal(helper.waiting.length, 1, "three asked for, one dialog");

    helper.answer(0);
    Harness.equal(helper.waiting.length, 1, "and still one");
    helper.answer(0);
    Harness.equal(helper.waiting.length, 1, "and still one");
    helper.answer(0);
    Harness.equal(helper.waiting.length, 0, "until they are all done");
    Harness.equal(helper.busy, false, "and then it is idle");
};

cases["a run asked for when nothing is queued still starts"] = function () {
    /* The other half of that guard: an empty queue means there is nothing to
     * start, but a queue with the job just pushed onto it is not empty. */
    let helper = deferredHelper();
    helper.run(["governor", "powersave"], () => {});
    Harness.equal(helper.waiting.length, 1, "the one job went out");
};

cases["a change on screen with nothing behind it is still a change in flight"] = function () {
    /*
     * `busy` is what the menu draws its controls insensitive from: while a
     * password dialog is up, a second click can only queue behind it, so the
     * controls say so rather than pretending to be ready. The commonest state
     * of all is one change in flight and nothing queued, and a reading of
     * busy that needed both would call that idle - which is the one case it
     * exists for.
     */
    let helper = deferredHelper();
    Harness.equal(helper.busy, false, "nothing asked for yet");

    helper.run(["governor", "powersave"], () => {});
    Harness.equal(helper.waiting.length, 1, "one dialog");
    Harness.equal(helper.busy, true, "and it is in flight, with nothing behind it");

    helper.answer(0);
    Harness.equal(helper.busy, false, "and now it is not");
};
