/*
 * What the user is told when a privileged change does not happen.
 *
 * This table was in applet.js, so the one part of the failure path a user ever
 * reads could only be seen by opening a session and breaking a helper.
 */

const Harness = imports.harness;

const Messages = Harness.requireXlet("./lib/helper-messages.js");

/* Every code the helper can report, and the applet's own two. */
const CODES = [
    "invalid-invocation", "invalid-value", "unsupported", "unavailable",
    "write-failed", "change-failed-restored", "rollback-failed",
    "helper-not-found", "unsafe-system-helper", "not-authorised",
    "helper-unavailable", "stale-system-helper", "helper-incompatible",
];

var cases = {};

cases["every code the helper reports has a sentence of its own"] = function () {
    let fallback = Messages.errorMessage({ code: "no such code" });
    for (let code of CODES) {
        let message = Messages.errorMessage({ code: code });
        Harness.ok(message, code + " says nothing");
        Harness.ok(message !== fallback,
                   code + " falls through to the general message");
    }
};

cases["a code nobody recognises still says something"] = function () {
    Harness.equal(Messages.errorMessage(), "The change could not be applied.",
                  "an outcome that is not there is still an outcome");
    Harness.equal(Messages.errorMessage({}), "The change could not be applied.",
                  "and so is one with no code in it");
};

cases["the two codes about a broken installation ask for the same repair"] = function () {
    Harness.equal(Messages.errorMessage({ code: "helper-not-found" }),
                  Messages.errorMessage({ code: "unsafe-system-helper" }),
                  "a missing helper and an unsafe one are repaired the same way");
};

cases["only an outdated helper is worth interrupting somebody about"] = function () {
    Harness.ok(Messages.warningMessage({ warningCode: "stale-system-helper" }),
               "the one warning there is");
    Harness.equal(Messages.warningMessage({ warningCode: "helper-unavailable" }), null,
                  "a helper that was busy is not a warning");
    Harness.equal(Messages.warningMessage({}), null, "nor is a clean outcome");
    Harness.equal(Messages.warningMessage(), null, "nor is no outcome at all");
    Harness.equal(Messages.warningMessage({ warningCode: "stale-system-helper" }),
                  Messages.errorMessage({ code: "stale-system-helper" }),
                  "and it is the same sentence whichever way it arrives");
};

cases["a change nobody allowed reports the setting, not the helper"] = function () {
    let outcome = Messages.disabledOutcome();
    Harness.equal(outcome.applied, false, "nothing was applied");
    Harness.equal(outcome.error, "Privileged controls are turned off",
                  "and the reason is the setting");
};

cases["only a failure nobody chose gains a sentence"] = function () {
    let applied = { applied: true, code: "write-failed" };
    Harness.equal(Messages.describedOutcome(applied), applied,
                  "a change that worked has nothing to explain");
    let cancelled = { applied: false, cancelled: true, code: "not-authorised" };
    Harness.equal(Messages.describedOutcome(cancelled), cancelled,
                  "and one the user cancelled is one they already know about");
    let failed = Messages.describedOutcome({ applied: false, code: "unsupported" });
    Harness.equal(failed.error, "This control is not supported on this system.",
                  "a failure is described in the words of somebody who has to fix it");
    Harness.equal(failed.code, "unsupported", "and keeps the code it arrived with");
    Harness.equal(Messages.describedOutcome(), undefined,
                  "an absent outcome is not invented");
};

cases["a profile that will not switch does not quote D-Bus at the user"] = function () {
    Harness.equal(
        Messages.profileErrorMessage("performance",
                                     { message: "GDBus.Error:org.freedesktop.DBus.Error.Failed: no" }),
        "Could not switch to Performance: no",
        "the error name Gio prefixes means nothing to the person reading it");
    Harness.equal(
        Messages.profileErrorMessage("performance", { message: "   " }),
        "Could not switch to Performance",
        "and a detail that is only the prefix is no detail, not an empty one");
    Harness.equal(
        Messages.profileErrorMessage("balanced", "plain failure"),
        "Could not switch to Balanced: plain failure",
        "something thrown that is not an Error still describes");
};
