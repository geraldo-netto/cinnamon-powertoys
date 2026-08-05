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

const Log = require("./lib/log.js");

/* pkexec's own exit codes: the dialog was closed, or the password did not
 * check out. Both mean the user knows perfectly well nothing happened. */
var PKEXEC_DISMISSED = 126;
var PKEXEC_UNAUTHORISED = 127;

function _spawn(argv, onDone) {
    let process;
    try {
        process = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDERR_PIPE,
        });
        process.init(null);
    } catch (error) {
        onDone(-1, String(error));
        return;
    }

    process.communicate_utf8_async(null, null, (source, result) => {
        try {
            let [, , stderr] = source.communicate_utf8_finish(result);
            /* A process that was killed never exited, and asking one for an
             * exit status is a GLib CRITICAL rather than a number - the same
             * assertion lib/ddc.js guards its own read with. Nothing here
             * kills pkexec, so this is the session going down with a password
             * dialog on screen, the polkit agent dying, or the OOM killer;
             * each of them is a change that did not happen, which is what -1
             * already means to _outcome. */
            onDone(source.get_if_exited() ? source.get_exit_status() : -1, stderr || "");
        } catch (error) {
            onDone(-1, String(error));
        }
    });
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
     * `candidates` are the helper paths to try in order - in the applet, the
     * root owned copy the polkit action names, then the one that shipped with
     * the applet. `exists` and `repair` are how the caller reaches the file
     * system, so this module needs none of its own.
     */
    constructor(candidates, exists, repair, spawn) {
        this._candidates = candidates || [];
        this._exists = exists || (() => false);
        this._repair = repair || function () {};
        this._spawn = spawn || _spawn;

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
    }

    /*
     * The helper that will actually be run, or null when there is none. The
     * first candidate is the root owned one; only ours is ours to repair, so
     * the executable bit is only ever put back on the later candidates.
     */
    path() {
        for (let i = 0; i < this._candidates.length; i++) {
            let candidate = this._candidates[i];
            if (!this._exists(candidate))
                continue;
            if (i > 0)
                this._repair(candidate);
            return candidate;
        }
        return null;
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
        let helper = this.path();

        if (!helper) {
            job.done({ applied: false, code: "helper-not-found",
                       diagnostic: "the helper script could not be found",
                       error: "the helper script could not be found" });
            this._next();
            return;
        }

        this._running = true;
        let argv = ["pkexec", helper].concat(job.args.map(argument => String(argument)));
        this._spawn(argv, (status, stderr) => {
            this._running = false;
            job.done(this._outcome(status, stderr));
            this._next();
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
