/*
 * Running the privileged helper.
 *
 * The spawn is a parameter, so nothing here launches pkexec, asks for a
 * password or writes to /sys. What is checked is which helper gets picked,
 * what is handed to pkexec, and how each way the helper can end is reported.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");
const Log = Harness.requireXlet("./lib/log.js");

const SYSTEM = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";
const OWN = "/home/someone/.local/share/cinnamon/applets/x/powertoys-helper";

/* Builds a helper over a pretend file system and a pretend pkexec. */
function helperWith(present, answer) {
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM, OWN],
        path => present.indexOf(path) >= 0,
        function (argv, onDone) {
            spawned.push(argv.join(" "));
            onDone(answer[0], answer[1]);
        },
        yes);
    helper.spawned = spawned;
    return helper;
}

/*
 * A stubbed protocol handshake. A helper is only run once it has said it
 * understands this applet, and a spawn stub cannot execute a candidate to say
 * so - so a case that is about anything else says yes here on its behalf.
 */
function yes(path, onDone) {
    onDone(true, "");
}

var cases = {};

cases["the root owned helper is preferred"] = function () {
    let helper = helperWith([SYSTEM, OWN], [0, ""]);
    let path = Harness.settle(done => helper._locator.select(done), "helper selection");
    Harness.equal(path, SYSTEM, "the one the polkit action names");
};

cases["runtime trust accepts a protected root-owned executable"] = function () {
    let inspection = Privileged.inspectTrustedHelper("/usr/bin/true");
    Harness.equal(inspection.trusted, true,
                  "the helper and every directory leading to it are protected");
};

cases["runtime trust identifies a missing helper"] = function () {
    let inspection = Privileged.inspectTrustedHelper(
        "/definitely/not/an/installed/powertoys-helper");
    Harness.equal(inspection.trusted, false, "absence is not trusted");
    Harness.equal(inspection.code, "helper-not-found",
                  "absence remains distinct from unsafe permissions");
};

cases["runtime trust rejects a helper below a user-owned directory"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-untrusted-helper-XXXXXX");
    let path = directory + "/powertoys-helper";
    try {
        GLib.file_set_contents(path, "#!/bin/sh\nexit 0\n");
        GLib.chmod(path, 0o755);
        let inspection = Privileged.inspectTrustedHelper(path);
        Harness.equal(inspection.trusted, false, "a user-owned helper is not trusted");
        Harness.equal(inspection.code, "unsafe-system-helper",
                      "the caller can provide repair guidance");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["without an installed helper no user-owned copy is selected"] = function () {
    let helper = helperWith([], [0, ""]);
    let path = Harness.settle(done => helper._locator.select(done), "helper selection");
    Harness.equal(path, null, "a path below the applet is never a candidate");
};

cases["a trusted fallback preserves the primary warning"] = function () {
    let helper = new Privileged.PrivilegedHelper(
        ["/unsafe-helper", SYSTEM],
        path => path === SYSTEM ? true : {
            trusted: false,
            code: "unsafe-system-helper",
            diagnostic: "the primary helper is unsafe",
        },
        (argv, onDone) => onDone(0, ""), yes);
    let outcome = null;
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        helper.run(["boost", "1"], result => { outcome = result; });
    } finally {
        Log.setSink(null);
    }

    Harness.equal(outcome.applied, true, "the trusted fallback applies the change");
    Harness.equal(outcome.warningCode, "unsafe-system-helper",
                  "the rejected primary candidate is still reported");
    Harness.equal(outcome.warningDiagnostic, "the primary helper is unsafe",
                  "the original trust diagnostic is retained");
    Harness.equal(lines.length, 1, "the fallback is also visible in the log");
};

cases["an incompatible system helper is not elevated"] = function () {
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => { spawned.push(argv); onDone(0, ""); },
        (path, onDone) => onDone(false, "reported protocol 0"));
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });

    Harness.equal(spawned.length, 0, "pkexec never receives an unverified replacement");
    Harness.equal(outcome.applied, false, "the requested change is refused");
    Harness.equal(outcome.code, "stale-system-helper",
                  "and the installation problem is actionable");
};

cases["helper selection follows live installation changes"] = function () {
    let present = [];
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], path => present.indexOf(path) >= 0,
        (argv, onDone) => { spawned.push(argv[1]); onDone(0, ""); },
        (path, onDone) => onDone(true, ""));

    let missing = null;
    helper.run(["boost", "1"], outcome => { missing = outcome; });
    present = [SYSTEM];
    helper.run(["boost", "0"], () => {});
    present = [];
    let removed = null;
    helper.run(["boost", "1"], outcome => { removed = outcome; });

    Harness.deepEqual(spawned, [SYSTEM], "only the installed helper is run");
    Harness.equal(missing.code, "helper-not-found", "absence is reported before installation");
    Harness.equal(removed.code, "helper-not-found", "and after removal");
};

cases["helper protocol drift invalidates the installed candidate"] = function () {
    let systemCompatible = true;
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => { spawned.push(argv[1]); onDone(0, ""); },
        (path, onDone) => onDone(systemCompatible, "reported an old protocol"));

    helper.run(["boost", "1"], () => {});
    systemCompatible = false;
    let outcome = null;
    helper.run(["boost", "0"], result => { outcome = result; });

    Harness.deepEqual(spawned, [SYSTEM], "an incompatible helper is not run");
    Harness.equal(outcome.code, "stale-system-helper", "reinstallation is requested");
};

cases["a spawn failure forces helper reselection"] = function () {
    let probes = 0;
    let runs = 0;
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => onDone(runs++ === 0 ? -1 : 0, "spawn failed"),
        (path, onDone) => { probes++; onDone(true, ""); });

    helper.run(["boost", "1"], () => {});
    helper.run(["boost", "0"], () => {});
    Harness.equal(probes, 2, "the next job repeats the compatibility handshake");
};

cases["one caller that throws does not stop the queue"] = function () {
    /*
     * Every job ends the same way - release the queue, answer the caller,
     * start the next - and the answer is a callback that reaches applet code.
     * A throw out of one of them used to leave _running set inside a Gio
     * callback that nothing catches, so the applet would take no further
     * privileged change for the rest of the session.
     */
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        let helper = helperWith([SYSTEM], [0, ""]);
        let answers = [];
        helper.run(["boost", "1"], () => { throw new Error("caller exploded"); });
        helper.run(["boost", "0"], outcome => answers.push(outcome.applied));

        Harness.deepEqual(answers, [true], "the job behind the throwing one still ran");
        Harness.deepEqual(helper.spawned,
                          ["pkexec " + SYSTEM + " boost 1", "pkexec " + SYSTEM + " boost 0"],
                          "and both reached pkexec, in order");
        Harness.equal(helper.busy, false, "the queue is not stuck");
        Harness.equal(lines.filter(line => line.indexOf("caller exploded") >= 0).length, 1,
                      "with the failure reported once");
    } finally {
        Log.setSink(null);
    }
};

cases["a second selection ends the probe the first one left running"] = function () {
    /*
     * _activeProbe holds one probe, and it is what destroy() cancels. Starting
     * another selection while one is outstanding used to overwrite it, so the
     * abandoned probe's subprocess, its pipes and its two second timer were
     * beyond anybody's reach for the rest of the session.
     */
    let cancelled = 0;
    let settled = [];
    let helper = new Privileged.PrivilegedHelper(
        ["/helper"], () => true,
        (argv, onDone) => onDone(0, ""),
        function (path, onDone) {
            return function () {
                cancelled++;
                onDone(false, "probe cancelled", "");
            };
        });

    helper._locator.select(path => settled.push(path));
    Harness.equal(cancelled, 0, "the first probe is still out");
    helper._locator.select(path => settled.push(path));
    Harness.equal(cancelled, 1, "and the second selection ended it");
    Harness.deepEqual(settled, [null], "the abandoned selection is answered too");

    helper.destroy();
    Harness.equal(cancelled, 2, "teardown ends the one still running");
};

cases["with no helper at all, nothing is spawned"] = function () {
    let helper = helperWith([], [0, ""]);
    let outcome = null;
    helper.run(["governor", "powersave"], result => { outcome = result; });
    Harness.equal(helper.spawned.length, 0, "selection never reached a spawn");
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
    /* 126 is the dialog closed, whatever pkexec did or did not print. */
    let helper = helperWith([SYSTEM], [126, ""]);
    let outcome = null;
    helper.run(["governor", "powersave"], result => { outcome = result; });
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.cancelled, true, "the user already knows nothing happened");
    Harness.equal(outcome.code, undefined, "and there is nothing to report about it");
};

cases["a refusal the user was part of is still cancelled"] = function () {
    /* 127 covers a refusal as well as a failure, and pkexec's own line is the
     * only thing that tells them apart. Refused means asked and denied, which
     * the user watched happen. */
    for (let said of ["Error executing command as another user: Not authorized",
                      "Error executing command as another user: Request dismissed"]) {
        let helper = helperWith([SYSTEM], [127, said + "\n"]);
        let outcome = null;
        helper.run(["governor", "powersave"], result => { outcome = result; });
        Harness.equal(outcome.cancelled, true, said + ": nothing to tell them");
        Harness.equal(outcome.code, undefined, said + ": and no code either");
    }
};

cases["a pkexec that could not even ask is reported, not swallowed"] = function () {
    /*
     * pkexec exits 127 for its own errors as well as for a refusal: no
     * authentication agent on this session, the action file gone or
     * unparsable, the helper no longer executable between validation and
     * exec. Read as a dismissal those said nothing at all - no notification,
     * no log line - so a wholly broken privileged path looked exactly like a
     * user who had changed their mind.
     */
    for (let said of ["Error executing command as another user: No authentication agent found",
                      "pkexec must be setuid root",
                      ""]) {
        let helper = helperWith([SYSTEM], [127, said]);
        let outcome = null;
        helper.run(["boost", "1"], result => { outcome = result; });
        Harness.equal(outcome.applied, false, JSON.stringify(said) + ": not applied");
        Harness.equal(outcome.cancelled, undefined,
                      JSON.stringify(said) + ": and not passed off as a cancellation");
        Harness.equal(outcome.code, "not-authorised",
                      JSON.stringify(said) + ": a code the applet can put words to");
        Harness.equal(outcome.diagnostic, said.trim(),
                      JSON.stringify(said) + ": with whatever pkexec said for the log");
    }
};

cases["a structured helper failure keeps its code and diagnostic apart"] = function () {
    let helper = helperWith([SYSTEM], [1,
        "some shell detail\npowertoys-helper-error invalid-value unknown governor: nonsense\n"]);
    let outcome = null;
    helper.run(["governor", "nonsense"], result => { outcome = result; });
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.cancelled, undefined, "not cancelled either");
    Harness.equal(outcome.code, "invalid-value", "the stable UI vocabulary");
    Harness.equal(outcome.diagnostic, "unknown governor: nonsense", "the detail for the log");
    Harness.equal(outcome.error, "unknown governor: nonsense",
                  "the compatibility reason remains available to non-UI callers");
};

cases["a failure with nothing to say still reports a failure"] = function () {
    let helper = helperWith([SYSTEM], [1, ""]);
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.code, "helper-failed", "the generic code");
    Harness.equal(outcome.error, "", "with no reason to give, which the caller words itself");
};

/* A helper whose spawn is held open until the case says to answer. */
function deferredHelper() {
    let waiting = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => waiting.push({ argv: argv, onDone: onDone }), yes);
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

cases["what is queued when the applet leaves is answered, not spawned"] = function () {
    /*
     * Everything that comes back from here checks whether the applet is still
     * on the panel, which is why this went unnoticed: a pkexec dialog is not
     * something that comes back. Left alone, the queue went on spawning them.
     *
     * Not spawning them is only half of it. A queued caller that is never
     * called back waits for ever, and this class already answers a caller
     * that arrives after teardown with exactly this outcome; a caller that
     * arrived a moment earlier is owed the same.
     */
    let helper = deferredHelper();
    let finished = [];
    let queued = null;
    helper.run(["governor", "powersave"], () => finished.push("governor"));
    helper.run(["epp", "power"], result => {
        finished.push("epp");
        queued = result;
    });
    Harness.equal(helper.waiting.length, 1, "the first is running");

    helper.destroy();

    Harness.deepEqual(finished, ["epp"], "the queued one is answered at once");
    Harness.equal(queued.applied, false, "and told that nothing was applied");
    Harness.equal(queued.code, "shutting-down",
                  "with the same code run() gives a caller that arrives after teardown");
    Harness.equal(helper.waiting.length, 1,
                  "no second dialog for an applet that has gone");

    helper.answer(0);
    Harness.deepEqual(finished, ["epp", "governor"],
                      "the one already running still finishes");
    Harness.equal(helper.waiting.length, 0, "and nothing follows it");
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

cases["a helper probe does not spawn after the applet leaves"] = function () {
    let probeCancelled = 0;
    let spawned = [];
    let outcome = null;
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => spawned.push({ argv: argv, onDone: onDone }),
        (path, onDone) => () => {
            probeCancelled++;
            onDone(false, "protocol probe cancelled");
        });

    helper.run(["boost", "1"], result => { outcome = result; });
    Harness.equal(helper.busy, true, "and owns the current job");

    helper.destroy();

    Harness.equal(probeCancelled, 1, "the unfinished discovery process is cancelled");
    Harness.deepEqual(spawned, [], "pkexec never reaches the screen");
    Harness.equal(outcome.code, "shutting-down", "the detached job is settled");
    Harness.equal(helper.busy, false, "and no work remains owned");
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

cases["a helper that was killed never exited, and is not asked what it exited with"] = function () {
    /*
     * pkexec taken down by a signal rather than finishing: the session going
     * away with the password dialog still on screen, the polkit agent dying,
     * the OOM killer. g_subprocess_get_exit_status on a process that was
     * signalled is an assertion failure in the log and a number that stands
     * for nothing, which lib/ddc.js met from the other end - there the applet
     * kills the process itself, so it happens on every monitor that stops
     * answering.
     *
     * What it has to come back as is a failure, because that is what it is,
     * and it must not come back as 126 or 127 either - those two are pkexec
     * saying the user dismissed the dialog, which is the one outcome the
     * applet says nothing about.
     */
    let outcome = Harness.settle(done => Privileged._spawn(
        ["sh", "-c", "kill -TERM $$"], (status, stderr) =>
            done({ status: status, stderr: stderr })), "a process that was killed");
    Harness.equal(outcome.status, -1, "a failure of its own, not an exit status");

    let helper = new Privileged.PrivilegedHelper(
        ["/helper"], () => true,
        (argv, onDone) => Privileged._spawn(["sh", "-c", "kill -TERM $$"], onDone), yes);
    let reported = Harness.settle(done => helper.run(["boost", "1"], done), "the outcome");
    Harness.equal(reported.applied, false, "nothing was applied");
    Harness.ok(!reported.cancelled, "and the user did not dismiss anything, so they are told");
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
        ["/bin/echo"], path => path === "/bin/echo",
        (argv, onDone) => Privileged._spawn(argv.slice(1), onDone), yes);

    let outcome = Harness.settle(done => helper.run(["governor", "performance"], done),
                                 "a change that is applied");
    Harness.deepEqual(outcome, { applied: true }, "applied, with nothing else to say");
};

cases["what the helper prints is separated into code and diagnostic"] = function () {
    let helper = new Privileged.PrivilegedHelper(
        ["/bin/sh"], () => true,
        (argv, onDone) => Privileged._spawn(
            ["sh", "-c", "echo first line >&2; echo 'powertoys-helper-error unavailable no cpufreq policy found' >&2; exit 3"],
            onDone), yes);

    let outcome = Harness.settle(done => helper.run(["governor", "x"], done), "a refusal");
    Harness.equal(outcome.applied, false, "not applied");
    Harness.equal(outcome.code, "unavailable", "the code the applet translates");
    Harness.equal(outcome.diagnostic, "no cpufreq policy found",
                  "the last line's detail for the log");
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

cases["the structured failure works when it is the only line"] = function () {
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => onDone(1,
            "powertoys-helper-error invalid-value unknown governor: nonsense\n"), yes);
    let outcome = null;
    helper.run(["governor", "nonsense"], result => { outcome = result; });
    Harness.equal(outcome.code, "invalid-value", "the code");
    Harness.equal(outcome.error, "unknown governor: nonsense", "one line, and it is the reason");
};

cases["the shipped helper emits the structured contract"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-helper-contract-XXXXXX");
    let path = directory + "/powertoys-helper";
    try {
        let source = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
            .replace(/^LOCK_FILE=.*$/m, "LOCK_FILE=\"" + directory + "/lock\"");
        GLib.file_set_contents(path, source);
        GLib.chmod(path, 0o700);
        let result = Harness.settle(done => Privileged._spawn(
            [path, "boost", "not-a-switch"], (status, stderr) =>
                done({ status: status, stderr: stderr })), "the real helper refusing a value");
        Harness.equal(result.status, 1, "the value was refused");
        Harness.ok(/^powertoys-helper-error invalid-value /.test(result.stderr),
                   "and the final line carries a stable code: " + result.stderr);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["the shipped helper identifies its protocol before authentication"] = function () {
    let path = Harness.xletDir() + "/powertoys-helper";
    let compatible = Harness.settle(done => Privileged._probeHelper(
        path, (ok, diagnostic) => done({ ok: ok, diagnostic: diagnostic })),
        "the helper protocol probe");
    Harness.equal(compatible.ok, true, "the applet and bundled helper agree");
    Harness.equal(compatible.diagnostic, "", "with no compatibility warning");
};

cases["a helper probe that cannot start has a safe cancellation handle"] = function () {
    let answers = [];
    let cancel = Privileged._probeHelper(
        "/definitely/not/a/powertoys-helper",
        (compatible, diagnostic) => answers.push({
            compatible: compatible,
            diagnostic: diagnostic,
        }));

    Harness.equal(answers.length, 1, "the setup failure settles synchronously");
    Harness.equal(answers[0].compatible, false, "the missing executable is incompatible");
    cancel();
    Harness.equal(answers.length, 1, "late teardown cannot settle the failed probe again");
};

cases["a helper protocol probe that hangs is bounded"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-helper-hang-XXXXXX");
    let path = directory + "/powertoys-helper";
    try {
        GLib.file_set_contents(path, "#!/bin/sh\nsleep 5\n");
        GLib.chmod(path, 0o700);
        let answer = Harness.settle(done => Privileged._probeHelper(
            path, (compatible, diagnostic) =>
                done({ compatible: compatible, diagnostic: diagnostic }), 20),
            "a bounded helper protocol probe");
        Harness.equal(answer.compatible, false, "a hung executable is not compatible");
        Harness.equal(answer.diagnostic, "protocol probe timed out",
                      "the timeout is distinct from a protocol mismatch");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["a successful executable with no helper protocol is rejected"] = function () {
    let answer = Harness.settle(done => Privileged._probeHelper(
        "/bin/true", (compatible, diagnostic) =>
            done({ compatible: compatible, diagnostic: diagnostic })),
        "an executable that is not the helper");
    Harness.equal(answer.compatible, false, "exit success alone is not compatibility");
    Harness.equal(answer.diagnostic, "reported no protocol", "the missing handshake is explicit");

    let failed = Harness.settle(done => Privileged._probeHelper(
        "/bin/false", (compatible, diagnostic) =>
            done({ compatible: compatible, diagnostic: diagnostic })),
        "an executable that rejects the probe");
    Harness.equal(failed.compatible, false, "a failed probe is incompatible");
    Harness.ok(failed.diagnostic.indexOf("status") >= 0, "its exit status is retained");
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
            [SYSTEM], () => true,
            (argv, onDone) => onDone(3,
                "powertoys-helper-error unavailable no cpufreq policy found\n"), yes);
        helper.run(["governor", "x"], () => {});
        Harness.equal(lines.length, 1, "one line");
        Harness.equal(lines[0],
                      "[powertoys] helper failed with status 3 [unavailable]: no cpufreq policy found",
                      "the status, code and diagnostic, in that order");

        lines.length = 0;
        let quiet = new Privileged.PrivilegedHelper(
            [SYSTEM], () => true, (argv, onDone) => onDone(9, ""), yes);
        quiet.run(["boost", "1"], () => {});
        Harness.equal(lines[0],
                      "[powertoys] helper failed with status 9 [helper-failed]: no reason given",
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

/*
 * A probe that timed out and a probe that answered wrongly are two different
 * things. The first says nothing about the helper at all - a loaded machine
 * or a cold cache is enough - and used to be reported as the second, which
 * told the user to reinstall a helper that was never broken.
 */
cases["a probe that runs out of time says so"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-helper-slow-XXXXXX");
    let path = directory + "/powertoys-helper";
    try {
        GLib.file_set_contents(path, "#!/bin/sh\nsleep 5\n");
        GLib.chmod(path, 0o700);
        let answer = Harness.settle(done => Privileged._probeHelper(
            path, (compatible, diagnostic, reason) =>
                done({ compatible: compatible, diagnostic: diagnostic, reason: reason }), 20),
            "a bounded helper protocol probe");
        Harness.equal(answer.compatible, false, "nothing was verified");
        Harness.equal(answer.reason, "timed-out",
                      "and the caller is told which kind of no this is");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["an answered probe carries no transient reason"] = function () {
    let answer = Harness.settle(done => Privileged._probeHelper(
        "/bin/true", (compatible, diagnostic, reason) =>
            done({ compatible: compatible, reason: reason })),
        "an executable that is not the helper");
    Harness.equal(answer.compatible, false, "it is not the helper");
    Harness.equal(answer.reason, "", "but it did answer, so nothing is transient about it");

    let good = Harness.settle(done => Privileged._probeHelper(
        Harness.xletDir() + "/powertoys-helper",
        (compatible, diagnostic, reason) => done({ compatible: compatible, reason: reason })),
        "the shipped helper");
    Harness.equal(good.compatible, true, "the bundled helper agrees");
    Harness.equal(good.reason, "", "with nothing transient to report");
};

cases["a timed-out probe is not reported as an outdated helper"] = function () {
    let spawned = [];
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => { spawned.push(argv); onDone(0, ""); },
        (path, onDone) => onDone(false, "protocol probe timed out", "timed-out"));
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });

    Harness.equal(spawned.length, 0, "pkexec never receives an unverified helper");
    Harness.equal(outcome.applied, false, "the change is still refused");
    Harness.equal(outcome.code, "helper-unavailable",
                  "the helper is unavailable, not outdated");
    Harness.ok(outcome.diagnostic.indexOf("did not answer in time") >= 0,
               "and the log says what actually happened: " + outcome.diagnostic);
};

cases["a helper that answers wrongly is still reported as outdated"] = function () {
    let helper = new Privileged.PrivilegedHelper(
        [SYSTEM], () => true,
        (argv, onDone) => onDone(0, ""),
        (path, onDone) => onDone(false, "reported protocol 0", ""));
    let outcome = null;
    helper.run(["boost", "1"], result => { outcome = result; });
    Harness.equal(outcome.code, "stale-system-helper",
                  "a wrong answer is a helper that needs reinstalling");
};

cases["a timeout does not warn about an outdated helper on a later success"] = function () {
    /* The warning path: a rejected first candidate is carried as an issue on
     * whatever helper does run, and only an outdated one is worth interrupting
     * somebody about. A machine that was merely busy is not. */
    let source = Harness.shellSource();
    Harness.ok(source.indexOf('outcome?.warningCode !== "stale-system-helper"') >= 0,
               "the notification is still limited to the outdated helper");
    Harness.ok(source.indexOf('case "helper-unavailable":') >= 0,
               "and the transient code has a message of its own");
    Harness.ok(source.indexOf(
        '_("The privileged helper did not answer in time. Try that again.")') >= 0,
        "which asks for a retry rather than a reinstallation");
};
