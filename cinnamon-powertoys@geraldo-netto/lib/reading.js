/*
 * cinnamon-powertoys - what one reading of the machine comes to.
 *
 * A poll assembles a reading out of every backend; these are the questions
 * asked of it afterwards, by the panel and by the menu. Which profile to draw,
 * what the power figure means, whether the governor is this menu's to offer.
 *
 * They were free functions at the top of applet.js, which is 43% of the
 * JavaScript here and cannot be loaded outside Cinnamon, so none of them could
 * be checked. Nothing in them needs a widget or a shell - each is a function of
 * a reading and nothing else - and out here that is enforced rather than
 * intended.
 */

const PowerSupply = require("./lib/power-supply.js");
const Format = require("./lib/format.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * The power figure is not one thing: on battery it is what the battery is
 * losing, on a desktop it is the CPU package or the graphics card. They are
 * different enough that showing the number without saying which would be
 * misleading, so the source is always named alongside it.
 */
function powerSourceLabel(source) {
    switch (source) {
        case "battery": return _("battery");
        case "package": return _("package");
        case "gpu": return _("GPU");
        default: return "";
    }
}

function powerText(data) {
    if (data.systemWatts === null)
        return "";
    let label = powerSourceLabel(data.systemWattsSource);
    return Format.watts(data.systemWatts) + (label ? " (" + label + ")" : "");
}

/*
 * The same figure for the panel, where every character is expensive.
 *
 * What a battery is losing is the whole machine and needs no explanation. The
 * other two sources are one part of it - the processor package, a graphics
 * card - and a bare number there reads as system power when it is not: a
 * desktop that cannot read its RAPL counters would show the graphics card's
 * 54 W as if it were the lot. Those say which.
 */
function panelPowerText(data) {
    if (data.systemWattsSource === "battery")
        return Format.watts(data.systemWatts);
    return powerText(data);
}

/*
 * The profile the panel and the menu should be drawing.
 *
 * Neither backend answers at once - the daemon replies over D-Bus, the ACPI
 * path goes through a password dialog - and the panel used to keep the old
 * gauge and the old word until the next poll caught up, four seconds later by
 * default. Somebody who has just cycled the profile with the wheel or the
 * hotkey is looking straight at the panel, and what it said was that nothing
 * had happened; a notification was doing the work the panel should have been.
 *
 * So it draws what was asked for while that is in flight, which is what the
 * menu has always done with the same value. Nothing is invented: the applet
 * clears the pending profile when the machine confirms it, and clears it on
 * an error too, so a change that is refused takes the panel back with it.
 */
function shownProfile(data, options) {
    return (options && options.pendingProfile) || data.profile.active;
}

/*
 * Whether the power profile is what writes the governor and the energy
 * preference.
 *
 * power-profiles-daemon does: it sets both from whichever profile is in force
 * and sets them again on the next profile change or mains transition, so a
 * governor chosen by hand holds until then and no longer. To anybody using the
 * machine the profile and the governor are then one setting with two names,
 * and the menu says it once - as the profile, which is the one that sticks.
 *
 * The ACPI platform profile is not that. It writes firmware and never goes
 * near cpufreq, so where it is the only backend the governor is a separate
 * question and stays a control of its own. Same on a machine with no profiles.
 *
 * This is the largest thing the menu does differently from one machine to the
 * next - two settings are controls or readings depending on it - which is why
 * it is worth being a named function with cases behind it rather than a
 * condition written out at each of the three places that ask.
 */
function profileOwnsGovernor(data) {
    return data.profile.available && !!data.profile.backend &&
           data.profile.backend !== PowerSupply.PLATFORM_BACKEND;
}

/*
 * What a privileged change did, in the words the menu uses for it.
 *
 * The argument vectors are the helper's vocabulary, and this is the one place
 * that turns them back into something worth reading.
 *
 * The helper takes five commands and four of them are here. "platform-profile"
 * is not, and its absence is the point: this is only ever called from the
 * applet's _runHelper, which is what the CPU control and the charge control
 * were given, while the platform profile client was given _runHelperQuietly
 * instead. That one reports in its own words, because a profile that will not
 * switch is not the same news as a governor that will not - the profile has a
 * panel gauge and a filled segment saying what it is, and a failure has to take
 * both back. A branch was kept here for it anyway, which read as a fifth
 * caller that has never existed.
 */
function describeChange(args) {
    switch (args[0]) {
        case "governor":
            return _("Governor") + ": " + Format.governorLabel(args[1]);
        case "epp":
            return _("Energy preference") + ": " + Format.energyPreferenceLabel(args[1]);
        case "boost":
            return String(args[1]) === "1" ? _("Turbo boost on") : _("Turbo boost off");
        case "charge-threshold":
            return _("Charge limit") + ": " + args[1] + "%";
        default:
            return "";
    }
}
