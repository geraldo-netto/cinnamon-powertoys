/*
 * cinnamon-powertoys - running the privileged helper.
 *
 * The governor, the energy preference, turbo boost, the platform profile and
 * the charge limit are root owned, so changing one means running a small
 * validating script through pkexec. This is everything about doing that
 * except deciding whether to: finding the helper, making sure it can be run,
 * spawning it, and turning what comes back into an answer.
 *
 * It says whether the change was applied, refused or cancelled, and never
 * shows the user anything itself. Deciding what is worth interrupting
 * somebody for is the caller's business.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Log = require("./lib/log.js");

/* pkexec's own exit codes: the dialog was closed, or the password did not
 * check out. Both mean the user knows perfectly well nothing happened. */
var PKEXEC_DISMISSED = 126;
var PKEXEC_UNAUTHORISED = 127;
var HELPER_PROTOCOL = 2;
var HELPER_PROTOCOL_LINE = "cinnamon-powertoys-helper-protocol " + HELPER_PROTOCOL;
var PROBE_TIMEOUT_MS = 2000;

/*
 * pkexec makes the selected program root. A compatible protocol is not a
 * trust boundary: a helper below the caller's home can honestly answer the
 * probe and then be replaced before the authenticated run. Accept only a
 * regular, root-owned executable reached entirely through root-owned paths
 * that no group or other user can write.
 */
var inspectTrustedHelper = function inspectTrustedHelper(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS) &&
            !GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) {
        return {
            trusted: false,
            code: "helper-not-found",
            diagnostic: "the installed privileged helper could not be found",
        };
    }

    let current = Gio.File.new_for_path(path);
    let helper = true;
    try {
        while (current) {
            let info = current.query_info(
                "standard::type,unix::uid,unix::mode",
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let type = info.get_file_type();
            let mode = info.get_attribute_uint32("unix::mode");
            let uid = info.get_attribute_uint32("unix::uid");
            let expected = helper ? Gio.FileType.REGULAR : Gio.FileType.DIRECTORY;
            if (type !== expected || uid !== 0 || (mode & 0o022) !== 0 ||
                    (helper && (mode & 0o111) === 0)) {
                return {
                    trusted: false,
                    code: "unsafe-system-helper",
                    diagnostic: "the privileged helper path is not safely root owned: " +
                        current.get_path(),
                };
            }
            helper = false;
            current = current.get_parent();
        }
    } catch (error) {
        return {
            trusted: false,
            code: "unsafe-system-helper",
            diagnostic: "the privileged helper path could not be verified: " + String(error),
        };
    }
    return { trusted: true };
};

function _spawn(argv, onDone) {
    let process;
    try {
        process = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        process.init(null);
    } catch (error) {
        onDone(-1, String(error), "");
        return;
    }

    process.communicate_utf8_async(null, null, (source, result) => {
        try {
            let [, stdout, stderr] = source.communicate_utf8_finish(result);
            /* A process that was killed never exited, and asking one for an
             * exit status is a GLib CRITICAL rather than a number - the same
             * assertion lib/ddc.js guards its own read with. Nothing here
             * kills pkexec, so this is the session going down with a password
             * dialog on screen, the polkit agent dying, or the OOM killer;
             * each of them is a change that did not happen, which is what -1
             * already means to _outcome. */
            onDone(source.get_if_exited() ? source.get_exit_status() : -1,
                   stderr || "", stdout || "");
        } catch (error) {
            onDone(-1, String(error), "");
        }
    });
}

/* A helper identifies its command and failure vocabulary before pkexec is
 * involved. Executing the probe also verifies that the candidate is a regular
 * executable with a working interpreter rather than merely an existing path. */
function _probeHelper(path, onDone, timeoutMs) {
    let done = false;
    let timeoutId = 0;
    let cancellable = new Gio.Cancellable();
    let process;

    function finish(status, stderr, stdout) {
        if (done)
            return;
        done = true;
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }

        let answer = String(stdout || "").trim();
        if (status === 0 && answer === HELPER_PROTOCOL_LINE) {
            onDone(true, "");
            return;
        }
        let diagnostic = status === 0
            ? "reported " + (answer || "no protocol")
            : String(stderr || "probe exited with status " + status).trim();
        onDone(false, diagnostic);
    }

    function stop(diagnostic) {
        try {
            cancellable.cancel();
            process.force_exit();
        } catch (error) {
            /* already gone */
        }
        finish(-1, diagnostic, "");
    }

    try {
        process = new Gio.Subprocess({
            argv: [path, "protocol-version"],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        process.init(null);
    } catch (error) {
        finish(-1, String(error), "");
        return function () {};
    }

    let limit = timeoutMs === undefined ? PROBE_TIMEOUT_MS : timeoutMs;
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, limit, () => {
        timeoutId = 0;
        stop("protocol probe timed out");
        return GLib.SOURCE_REMOVE;
    });

    process.communicate_utf8_async(null, cancellable, (source, result) => {
        try {
            let [, stdout, stderr] = source.communicate_utf8_finish(result);
            finish(source.get_if_exited() ? source.get_exit_status() : -1,
                   stderr || "", stdout || "");
        } catch (error) {
            finish(-1, String(error), "");
        }
    });

    return () => stop("protocol probe cancelled");
}

/* The helper's final line is a stable code followed by a diagnostic for the
 * log. Older installed helpers and failures before the helper starts have no
 * such line, so retain their last line as a diagnostic under a generic code. */
function _failure(stderr) {
    let lines = (stderr || "").split("\n").map(line => line.trim()).filter(line => line !== "");
    let last = lines.length > 0 ? lines[lines.length - 1] : "";
    let structured = /^powertoys-helper-error\s+([a-z0-9-]+)(?:\s+(.*))?$/.exec(last);
    if (structured)
        return { code: structured[1], diagnostic: structured[2] || "" };
    return {
        code: "helper-failed",
        diagnostic: last.replace(/^powertoys-helper:\s*/, ""),
    };
}

var PrivilegedHelper = class PrivilegedHelper {
    /*
     * `candidates` are installed helper paths to try in order. `inspect` is
     * injectable so selection can be checked without requiring root-owned
     * fixtures; runtime uses inspectTrustedHelper above.
     */
    constructor(candidates, inspect, spawn, probe) {
        this._candidates = candidates || [];
        this._inspect = inspect || inspectTrustedHelper;
        this._spawn = spawn || _spawn;
        /* An injected spawn normally stands for pkexec in tests or another
         * integration and cannot execute a candidate directly. Such callers
         * may inject a probe too; runtime uses the real protocol handshake. */
        this._probe = probe || (spawn
            ? ((path, onDone) => onDone(true, ""))
            : _probeHelper);
        this._selection = null;
        this._activeProbe = null;

        /*
         * One at a time. Two clicks in quick succession used to spawn two
         * pkexec processes and put two password dialogs on screen, one behind
         * the other, for two settings - and whichever the user answered
         * first, the other was still waiting. A queue makes it one dialog and
         * one change after another, in the order they were asked for.
         */
        this._queue = [];
        this._running = false;
        this._destroyed = false;
    }

    /*
     * The applet is leaving the panel. Whatever has not been started is
     * dropped, and nothing new is taken.
     *
     * Every other backend has one of these and this one did not, which went
     * unnoticed because everything that comes *back* from here checks whether
     * the applet is still there. A pkexec dialog is not something that comes
     * back: with two changes queued, removing the applet left the second one
     * still to be spawned, so a password dialog appeared for an applet that
     * was no longer on the panel, to make a change nobody could see the result
     * of.
     *
     * The job already running is deliberately left alone. Its dialog is on
     * screen, the user asked for it and may be halfway through answering, and
     * taking that away is worse than letting a change they asked for finish.
     */
    destroy() {
        this._destroyed = true;
        this._queue = [];
        let activeProbe = this._activeProbe;
        this._activeProbe = null;
        if (activeProbe && activeProbe.cancel)
            activeProbe.cancel();
    }

    /*
     * The trusted helper that will actually be run, or null when there is
     * none. Selection is repeated for every job so an installation changed
     * while Cinnamon is alive is adopted without reloading the applet.
     */
    path(onDone) {
        let done = onDone || function () {};
        /* A deployment can add, replace or remove the system candidate while
         * Cinnamon keeps this object alive. Selection is therefore a hint for
         * diagnostics, never an authority: every job rechecks candidates in
         * priority order and repeats the protocol handshake. */
        this._selection = null;
        this._tryCandidate(0, null, done);
        return null;
    }

    _tryCandidate(index, issue, onDone) {
        if (index >= this._candidates.length) {
            this._selection = { path: null, issue: issue };
            onDone(null, issue);
            return;
        }

        let candidate = this._candidates[index];
        let inspection = this._inspect(candidate);
        let trusted = inspection === true || (inspection && inspection.trusted === true);
        if (!trusted) {
            let rejected = inspection && inspection.code ? inspection : null;
            this._tryCandidate(index + 1, issue || rejected, onDone);
            return;
        }

        let activeProbe = { cancel: null };
        this._activeProbe = activeProbe;
        let cancel = this._probe(candidate, (compatible, diagnostic) => {
            if (this._activeProbe === activeProbe)
                this._activeProbe = null;
            if (this._destroyed) {
                onDone(null, issue);
                return;
            }
            if (compatible) {
                this._selection = { path: candidate, issue: issue };
                if (issue)
                    Log.error(issue.diagnostic + "; using " + candidate);
                onDone(candidate, issue);
                return;
            }
            let rejected = {
                code: index === 0 ? "stale-system-helper" : "helper-incompatible",
                diagnostic: (index === 0
                    ? "the installed privileged helper is incompatible"
                    : "a privileged helper is incompatible") +
                    (diagnostic ? ": " + diagnostic : ""),
            };
            this._tryCandidate(index + 1, issue || rejected, onDone);
        });
        if (this._activeProbe === activeProbe && typeof cancel === "function")
            activeProbe.cancel = cancel;
    }

    /*
     * Runs one command. onDone gets an outcome:
     *
     *   { applied: true }                  the helper did it
     *   { applied: false, cancelled: true} the user closed the dialog or the
     *                                      password was wrong - they know
     *   { applied: false, code: "...", diagnostic: "..." }
     *                                      something else, with a stable code
     *                                      for UI text and detail for the log
     */
    run(args, onDone) {
        let done = onDone || function () {};
        if (this._destroyed) {
            done({ applied: false, code: "shutting-down",
                   diagnostic: "the applet is shutting down",
                   error: "the applet is shutting down" });
            return;
        }
        this._queue.push({ args: args, done: done });
        this._next();
    }

    /* Whether a change is in flight. Callers use it to show that something is
     * happening rather than looking as though nothing did. */
    get busy() {
        return this._running || this._queue.length > 0;
    }

    _next() {
        if (this._destroyed || this._running || this._queue.length === 0)
            return;

        let job = this._queue.shift();
        this._running = true;
        this.path((helper, issue) => {
            /* Selecting a helper is asynchronous on the first run. Destroying
             * the applet while its protocol probe is out means no pkexec
             * process has reached the screen yet, so this job is still safe
             * to stop rather than treating it as the already-visible dialog
             * destroy() deliberately leaves alone. */
            if (this._destroyed) {
                this._running = false;
                job.done({ applied: false, code: "shutting-down",
                           diagnostic: "the applet is shutting down",
                           error: "the applet is shutting down" });
                return;
            }
            if (!helper) {
                this._running = false;
                let diagnostic = issue ? issue.diagnostic : "the helper script could not be found";
                job.done({ applied: false,
                           code: issue ? issue.code : "helper-not-found",
                           diagnostic: diagnostic, error: diagnostic });
                this._next();
                return;
            }

            let argv = ["pkexec", helper].concat(job.args.map(argument => String(argument)));
            this._spawn(argv, (status, stderr) => {
                this._running = false;
                /* Failure before a helper could report its own structured
                 * result may mean the selected path vanished or changed.
                 * Force the next queued job through discovery again. */
                if (status === -1)
                    this._selection = null;
                let outcome = this._outcome(status, stderr);
                if (issue)
                    outcome = Object.assign({}, outcome, {
                        warningCode: issue.code,
                        warningDiagnostic: issue.diagnostic,
                    });
                job.done(outcome);
                this._next();
            });
        });
    }

    _outcome(status, stderr) {
        if (status === 0)
            return { applied: true };
        if (status === PKEXEC_DISMISSED || status === PKEXEC_UNAUTHORISED)
            return { applied: false, cancelled: true };
        let failure = _failure(stderr);
        Log.error("helper failed with status " + status + " [" + failure.code + "]: " +
                  (failure.diagnostic || "no reason given"));
        return { applied: false, code: failure.code, diagnostic: failure.diagnostic,
                 /* Kept for callers outside the applet during the transition
                  * to codes; UI code must use code, never this raw text. */
                 error: failure.diagnostic };
    }
};
