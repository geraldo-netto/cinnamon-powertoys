/*
 * cinnamon-powertoys - what is made of a profile reading.
 *
 * Three questions get asked about the power profile, in three places, and each
 * of them used to be answered inside a method that also did something with the
 * answer - so the reasoning was mixed with the drawing and could not be asked
 * anything by a test.
 *
 *   - what the menu should show, which is nine values derived from one reading
 *     and the options, and was the whole of a forty-line _updateProfiles;
 *   - whether the block may be stepped at all, which the wheel, the middle
 *     click, the hotkey and the menu each have to agree about;
 *   - whether a snapshot or a reply still belongs to the backend that started
 *     it, which is the same comparison in three places and the reason a reply
 *     from a daemon that has since lost ownership is dropped.
 *
 * All of it is derivation from values, so all of it is here, and the callers
 * are left with the applying.
 */

const Format = require("./lib/format.js");
const Reading = require("./lib/reading.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * Which writer a profile snapshot came from.
 *
 * The backend object alone is not enough: the same daemon can be adopted
 * again after the name has changed owner, and a reply from before that is not
 * about the machine as it is now. So the generation counter travels with it,
 * and both have to match.
 */
function sameOwner(state, backend, generation) {
    return !!state && state.source === backend && state.generation === generation;
}

/* The holds one line, as "Firefox → Performance, Steam → Performance". */
function holdsText(holds) {
    let lines = [];
    for (let hold of holds || []) {
        lines.push(Translate.interpolate(_("%{application} → %{profile}"), {
            application: hold.application || _("an application"),
            profile: Format.profileLabel(hold.profile),
        }));
    }
    return lines.join(", ");
}

/*
 * Everything the menu's profile group draws, from one reading.
 *
 * `active` follows what was asked for rather than what has arrived: a
 * selection that springs back for a second while the daemon thinks about it
 * reads as the click having missed. The panel gauge and the panel label answer
 * the same question, which is why all three ask it of Reading.shownProfile.
 *
 * A list of one is not a list. amd-pstate narrows the choice to a single
 * value, and a control offering a choice that does not exist claims the user
 * has a say they have not got - so that case becomes a plain value row and the
 * segments are taken away.
 *
 * Degradation is a hardware constraint; a hold is an application's deliberate
 * request. They are separate lines because showing both as a warning made a
 * performance request read as though performance had been limited.
 */
function menuView(data, options) {
    let profile = data.profile;
    let show = !!options.showProfiles && profile.available && profile.list.length > 0;
    let active = Reading.shownProfile(data, options);
    let single = show && profile.list.length === 1;
    let degraded = show && profile.degraded
        ? Format.performanceDegradedLabel(profile.degraded) : "";
    let holds = show ? holdsText(profile.holds) : "";

    return {
        show: show,
        active: active,
        editable: Reading.profileCanChange(data, options.profilePrivileged),
        single: single,
        /* The segments and the value row are the same control in two shapes,
         * so exactly one of them is on screen at a time. */
        choices: show && !single ? profile.list : [],
        showChoices: show && !single,
        valueText: single ? Format.profileLabel(active || profile.list[0]) : "",
        degradedText: degraded,
        holdsText: holds,
    };
}

/*
 * The profile block a caller may step, or null.
 *
 * `context` is what the applet knows that the reading does not: which backend
 * it is currently talking to and at which generation, whether that backend is
 * the ACPI platform profile, whether a privileged change is on screen, and
 * whether the user has allowed privileged changes at all.
 *
 * Null for any of the reasons a change would not arrive: nothing to choose
 * from, a snapshot from a writer that no longer owns the setting, a password
 * dialog already up for the platform profile, or a control this applet is not
 * allowed to write.
 */
function steppableState(data, context) {
    let state = data ? data.profile : null;
    if (!state?.available || state.list.length === 0)
        return null;
    if (!sameOwner(state, context.backend, context.generation))
        return null;
    if (state.source === context.platformProfiles && context.busy)
        return null;
    if (!Reading.profileCanChange(data, context.privileged))
        return null;
    return state;
}
