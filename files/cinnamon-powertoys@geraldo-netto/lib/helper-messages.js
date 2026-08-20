/*
 * What the user is told when a privileged change does not happen.
 *
 * The helper reports a code. Its own diagnostics describe kernel and
 * filesystem details for the log and are not UI strings; the codes are
 * deliberately broader and stable, so these messages can be translated without
 * coupling the catalogue to a shell, a driver or a path.
 *
 * The table lived in applet.js, so the one part of the failure path a user ever
 * reads could only be checked by opening a session and breaking a helper. It is
 * a function of an outcome here: a code goes in, a sentence comes out, and
 * nothing in it knows there is a tray to say it in.
 */

const Format = require("./lib/format.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/* Said once, by two of the messages below: an outdated helper is reported both
 * as the reason a change failed and as a warning beside one that worked. */
function outdatedHelperMessage() {
    return _("The installed privileged helper is outdated. Re-run the policy installation.");
}

/*
 * The outcomes that are meant to get the general sentence, and why.
 *
 * Every other code below is answered with words about that code. These two
 * are not, and saying so here is what makes the difference deliberate: the
 * codes are read off the helper and off the applet's own failure paths by
 * tests/cases/helper-messages.js, and anything produced that is neither
 * answered nor named here is a failure the user is told nothing specific
 * about because somebody forgot, rather than because there is nothing to say.
 *
 * `helper-failed` is the helper exiting without the structured report - the
 * diagnostic is whatever it printed last, which is not a sentence for a
 * notification. `shutting-down` is every path answering at once because the
 * applet is going away, and there is nobody left to read it.
 */
var GENERIC_CODES = ["helper-failed", "shutting-down"];

/* Why a change did not happen, in the words of somebody who has to fix it. */
function errorMessage(outcome) {
    switch (outcome?.code) {
    case "invalid-invocation":
    case "invalid-value":
        return _("The requested value is not valid for this control.");
    case "unsupported":
        return _("This control is not supported on this system.");
    case "unavailable":
        return _("This control is currently unavailable.");
    case "write-failed":
        return _("The system refused the requested change.");
    case "change-failed-restored":
        return _("The change failed; the previous settings were restored.");
    case "rollback-failed":
        return _("The change failed and some previous settings could not be restored.");
    case "helper-not-found":
    case "unsafe-system-helper":
        return _("Install or repair the privileged helper with sudo make install-policy.");
    /* pkexec could not put the question at all - no authentication agent on
     * this session, or an action it could not read - so unlike a refusal,
     * nobody has been shown anything and there is nothing the user has already
     * seen us fail to do. */
    case "not-authorised":
        return _("The system could not ask for authorisation. Check that an " +
                 "authentication agent is running, and that the policy is " +
                 "installed with sudo make install-policy.");
    /* The helper never answered, so nothing is known to be wrong with it and
     * there is nothing for the user to repair. Asking again is the whole
     * remedy. */
    case "helper-unavailable":
        return _("The privileged helper did not answer in time. Try that again.");
    case "stale-system-helper":
        return outdatedHelperMessage();
    case "helper-incompatible":
        return _("The privileged helper is incompatible with this applet version.");
    /* Not the helper's; this applet's own refusal, from disabledOutcome below.
     * It is the one refusal here that knows exactly why and what to do about
     * it, and it used to be the one that said the least: the sentence was
     * built into the outcome and then replaced by the general one, because
     * this table answers a code and there was no code on it. */
    case "privileged-controls-off":
        return _("Privileged controls are turned off");
    default:
        return _("The change could not be applied.");
    }
}

/*
 * Something worth saying about a change that did work, or null.
 *
 * Only one thing qualifies so far. It is a separate question from the error
 * because it arrives beside a success, and a warning that only ever fired on
 * failure would never be seen on the machine it is about.
 */
function warningMessage(outcome) {
    if (outcome?.warningCode !== "stale-system-helper")
        return null;
    return outdatedHelperMessage();
}

/* The outcome of a change nobody allowed: the setting is off, so there is
 * nothing to authorise and nothing to report from the helper. */
function disabledOutcome() {
    return {
        applied: false,
        code: "privileged-controls-off",
        error: errorMessage({ code: "privileged-controls-off" }),
    };
}

/*
 * An outcome with a sentence in it, for a caller that reports in its own
 * words.
 *
 * A cancelled change is one the user cancelled and already knows about, and an
 * applied one has nothing to explain, so neither gains a message.
 */
function describedOutcome(outcome) {
    if (!outcome || outcome.applied || outcome.cancelled)
        return outcome;
    return { ...outcome, error: errorMessage(outcome) };
}

/*
 * A profile that would not switch.
 *
 * Gio prefixes a remote error with the D-Bus error name, which means nothing to
 * the person reading the notification, so it is taken off. What is left is
 * often nothing at all, which is its own sentence rather than a colon with
 * emptiness after it.
 */
function profileErrorMessage(name, error) {
    let detail = error?.message ? error.message : String(error);
    detail = detail.replace(/^GDBus\.Error:[^\s:]+:\s*/, "").trim();
    let values = { profile: Format.profileLabel(name), detail: detail };
    return detail
        ? Translate.interpolate(_("Could not switch to %{profile}: %{detail}"), values)
        : Translate.interpolate(_("Could not switch to %{profile}"), values);
}
