/*
 * What the user is told when a privileged change does not happen.
 *
 * This table was in applet.js, so the one part of the failure path a user ever
 * reads could only be seen by opening a session and breaking a helper.
 */

const Harness = imports.harness;

const Messages = Harness.requireXlet("./lib/helper-messages.js");

const Scan = imports.scan;
const Sources = imports.sources;

/*
 * Every code that can reach this table, read off the two things that produce
 * one rather than written out here.
 *
 * It was written out here - thirteen of them, in a list beside the table they
 * were about - which is the list a person editing the table is the most
 * likely to update and the least likely to be corrected by. The helper is a
 * shell script that `die`s with a code, and the applet's own failure paths
 * write one into an outcome; both are enumerated, so a code added to either
 * arrives here whether or not anybody remembered this file.
 */
function helperCodes() {
    let script = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
        .split("\n").filter(line => !/^\s*#/.test(line)).join("\n");
    let found = {};
    let pattern = /(?:\bdie|powertoys-helper-error)\s+([a-z][a-z-]*)/g;
    let match;
    while ((match = pattern.exec(script)) !== null)
        found[match[1]] = true;
    return Object.keys(found).sort();
}

/*
 * The applet's own: a code written into an outcome by one of the modules that
 * report a privileged change.
 *
 * The name is taken from the assignment and then checked against the file's
 * string literals, so a code named in the comment that explains it - and
 * every one of them is named there - is not counted as one that can happen.
 */
function appletCodes() {
    let found = {};
    /* Including this table's own file, which produces one: the applet's
     * refusal to make a privileged change nobody has allowed is not a helper
     * outcome and there is no helper in it, so it is written where the
     * sentence for it is. Skipping the file meant that code was answered by
     * the table and produced, as far as this case could see, by nothing. The
     * `case` labels below are not assignments and are not counted as one. */
    for (let relative of Sources.jsFiles(Harness.xletDir(), "")) {
        let source = Harness.readFile(Harness.xletDir() + "/" + relative);
        let written = Scan.literals(source);
        let assignments = /\bcode:[^,;}\n]*/g;
        let assignment;
        while ((assignment = assignments.exec(source)) !== null) {
            let names = /"([a-z][a-z-]*)"/g;
            let name;
            while ((name = names.exec(assignment[0])) !== null) {
                if (written.indexOf(name[1]) >= 0)
                    found[name[1]] = true;
            }
        }
    }
    return Object.keys(found).sort();
}

/* Every code the table answers, from the switch itself. */
function answeredCodes() {
    let source = Harness.readFile(Harness.xletDir() + "/lib/helper-messages.js")
        .replace(/\/\*[\s\S]*?\*\//g, " ");
    let found = {};
    let pattern = /case "([a-z][a-z-]*)":/g;
    let match;
    while ((match = pattern.exec(source)) !== null)
        found[match[1]] = true;
    return Object.keys(found).sort();
}

var cases = {};

cases["every code that can happen is answered, or says why it is not"] = function () {
    let fallback = Messages.errorMessage({ code: "no such code" });
    let produced = helperCodes().concat(appletCodes());
    Harness.ok(produced.length > 10,
               "only " + produced.length + " codes found, which is too few to be the whole of them");
    let unanswered = [];
    for (let code of produced) {
        let message = Messages.errorMessage({ code: code });
        Harness.ok(message, code + " says nothing");
        if (message !== fallback)
            continue;
        if (Messages.GENERIC_CODES.indexOf(code) < 0)
            unanswered.push(code);
    }
    Harness.deepEqual(unanswered, [],
                      "a code with no sentence of its own and no reason for having none");
};

cases["nothing is answered that cannot happen"] = function () {
    /* The other direction. A case for a code nothing produces is a sentence
     * in the catalogue that no translator's work will ever be read, and the
     * usual reason for one is a code that was renamed on the side that
     * reports it. */
    let produced = helperCodes().concat(appletCodes());
    let dead = answeredCodes().filter(code => produced.indexOf(code) < 0);
    Harness.deepEqual(dead, [], "answered by the table and produced by nothing");
    let unproduced = Messages.GENERIC_CODES.filter(code => produced.indexOf(code) < 0);
    Harness.deepEqual(unproduced, [],
                      "and excused by name and produced by nothing");
};

cases["the codes excused from a sentence get the general one"] = function () {
    let fallback = Messages.errorMessage({ code: "no such code" });
    for (let code of Messages.GENERIC_CODES) {
        Harness.equal(Messages.errorMessage({ code: code }), fallback,
                      code + " is excused a sentence, so it has to be getting the general one");
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
