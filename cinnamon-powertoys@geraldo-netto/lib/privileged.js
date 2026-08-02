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
            onDone(source.get_exit_status(), stderr || "");
        } catch (error) {
            onDone(-1, String(error));
        }
    });
}

/* The helper explains itself on stderr, so the last line is the reason. */
function _reason(stderr) {
    let lines = (stderr || "").split("\n").map(line => line.trim()).filter(line => line !== "");
    let last = lines.length > 0 ? lines[lines.length - 1] : "";
    return last.replace(/^powertoys-helper:\s*/, "");
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
     *   { applied: false, error: "..." }   something else, with the reason
     */
    run(args, onDone) {
        let done = onDone || function () {};
        let helper = this.path();

        if (!helper) {
            done({ applied: false, error: "the helper script could not be found" });
            return;
        }

        let argv = ["pkexec", helper].concat(args.map(argument => String(argument)));
        this._spawn(argv, (status, stderr) => {
            if (status === 0) {
                done({ applied: true });
                return;
            }
            if (status === PKEXEC_DISMISSED || status === PKEXEC_UNAUTHORISED) {
                done({ applied: false, cancelled: true });
                return;
            }
            let reason = _reason(stderr);
            Log.error("helper failed with status " + status + ": " + (reason || "no reason given"));
            done({ applied: false, error: reason });
        });
    }
};
