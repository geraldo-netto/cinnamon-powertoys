/*
 * cinnamon-powertoys - what the panel says about a reading.
 *
 * The text beside the icon, the six lines of the tooltip, and which of the
 * three things the icon is drawn from. Each is a function of one reading and
 * the options in force; none of them touches the panel, which is why they are
 * out here where they can be asked.
 *
 * They were methods on the panel presenter in applet.js, which cannot be
 * loaded outside Cinnamon - so the rules in them, and they are rules rather
 * than formatting, went unexercised: when a profile is worth saying in words
 * beside a gauge that already says it, how many accessories fit in a tooltip
 * before the rest are counted instead, and what a machine with nothing to
 * report says.
 */

const Device = require("./lib/device.js");
const Format = require("./lib/format.js");
const Reading = require("./lib/reading.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/* How many accessories the tooltip names before it starts counting them
 * instead. Three, plus the machine's own four or five lines, is about as much
 * as a tooltip is read in one glance. */
var TOOLTIP_PERIPHERALS = 3;

/*
 * What may be in the panel text, from one list rather than three switches.
 *
 * Three independent switches are eight arrangements to consider, and the ones
 * anybody wants are the charge, the charge and the draw, or nothing at all.
 * Those are the list; the switches are still there under "Choose below" for
 * the arrangement that is not on it, and `switches` is what they say.
 */
function panelParts(choice, switches) {
    let chosen = switches || {};
    switch (choice) {
        case "none":
            return { battery: false, power: false, profile: false };
        case "battery-power":
            return { battery: true, power: true, profile: false };
        case "custom":
            return { battery: !!chosen.battery, power: !!chosen.power,
                     profile: !!chosen.profile };
        default:
            return { battery: true, power: false, profile: false };
    }
}

/*
 * The list entry that means what the three switches meant.
 *
 * A machine that has run this applet before has them set the way somebody
 * wanted them, and a setting that did not exist then arrives at its default -
 * so without this an upgrade would quietly take the power draw out of
 * somebody's panel. Where the switches say what one of the entries says, that
 * entry is the answer; where they say something else, the answer is "custom"
 * and the switches go on doing exactly what they did.
 *
 * It is read once per install and can never be run again to see whether it was
 * right, which is the whole reason it is worth having out here.
 */
function migratedPanelText(switches) {
    let chosen = switches || {};
    let battery = !!chosen.battery;
    let power = !!chosen.power;
    let profile = !!chosen.profile;

    if (battery && !power && !profile)
        return "battery";
    if (battery && power && !profile)
        return "battery-power";
    if (!battery && !power && !profile)
        return "none";
    return "custom";
}

/* "auto" settled: the battery if there is one, otherwise the profile if
 * there is one. The label needs to know as well as the icon does. */
function iconSource(data, wanted, profile) {
    let source = wanted || "auto";
    if (source !== "auto")
        return source;
    return data.primary ? "battery" : (profile ? "profile" : "static");
}

/*
 * Whether the active profile still needs saying in words.
 *
 * On a desktop there is no battery, so the icon settles on the profile
 * gauge - and "Balanced" printed beside the balanced gauge is one fact
 * taking two pieces of the panel. Where two of the machine's own profiles
 * draw the same gauge, though, the word is the only thing telling them
 * apart, and it stays.
 */
function profileNeedsSpelling(data, source, profile) {
    if (!profile)
        return false;
    if (source !== "profile")
        return true;
    return !Format.profileIconIsUnambiguous(profile, data.profile.list);
}

/*
 * The text beside the icon.
 *
 * What may be in it is a charge, a draw and a profile, and the rule for
 * that is one rule rather than a list: a number that moves every few
 * seconds in the corner of the eye is the one thing on a panel that will
 * not be ignored, and none of these is worth that. Nobody acts on 61
 * degrees rather than 59, and nobody acts on 4.30 GHz rather than 4.28.
 *
 * The temperature was kept out on exactly that reasoning while the
 * frequency was offered beside it, which was two rules where the machine
 * only has one kind of number. The frequency has gone the same way. Both
 * are still in the menu, under the processor's own name, where they are
 * looked at on purpose - and the temperature is in the tooltip, which is
 * read by choosing to hover.
 *
 * A charge and a draw move slowly and mean something at a glance: how long
 * is left, and whether the machine is idling or working. The profile does
 * not move at all unless somebody moves it.
 */
function labelText(data, options, source, profile) {
    let parts = [];
    if (options.showBattery && data.primary && data.primary.percentage !== null)
        parts.push(Format.percent(data.primary.percentage));
    if (options.showPower && data.systemWatts !== null)
        parts.push(Reading.panelPowerText(data));
    if (options.showProfile && profileNeedsSpelling(data, source, profile))
        parts.push(Format.profileLabel(profile));
    /* Four figures about four different things, joined by a space, read as
     * one string: "97% 12 W 4.30 GHz Balanced". The dot is what says where
     * each of them ends, and it is the one the menu's own summary line
     * uses for the same job. */
    return parts.join(" · ");
}

function tooltipText(data, options) {
    let lines = [];

    if (data.primary) {
        lines.push(Format.deviceKindName(data.primary.kind) + " " +
                   Format.percent(data.primary.percentage) + " - " +
                   Format.deviceStateName(data.primary.state));
        let remaining = Device.remainingText(data.primary);
        if (remaining)
            lines.push(remaining);
    } else if (data.lineOnline || !data.upowerAvailable) {
        lines.push(_("Running on AC power"));
    }

    let profile = Reading.shownProfile(data, options);
    if (profile)
        lines.push(_("Profile") + ": " + Format.profileLabel(profile));
    if (data.cpu.governor)
        lines.push(_("Governor") + ": " + Format.governorLabel(data.cpu.governor));
    if (data.cpuTemperature !== null)
        lines.push(_("Temperature") + ": " +
                   Format.temperature(data.cpuTemperature, options.tempUnit, 1));
    if (data.systemWatts !== null)
        lines.push(_("Power draw") + ": " + Reading.powerText(data));

    /*
     * The accessories, after a blank line and never more than a few.
     *
     * This was one line per connected thing with a charge in it, with
     * nothing between them and the machine's own lines. A desk with a
     * mouse, a keyboard, a headset and two controllers made an eleven line
     * tooltip, which is not read at all: past about seven lines a list
     * stops being something anybody takes in at a glance, and a tooltip
     * only exists for the glance.
     *
     * The emptiest are the ones worth knowing about, so they are the ones
     * that fit, and the rest are counted rather than dropped silently -
     * the menu lists every one of them under Devices.
     */
    let peripherals = data.devices
        .filter(device => !device.powerSupply && device.percentage !== null)
        .slice()
        .sort((first, second) => first.percentage - second.percentage);

    if (peripherals.length > 0 && lines.length > 0)
        lines.push("");
    for (let device of peripherals.slice(0, TOOLTIP_PERIPHERALS))
        lines.push(Format.deviceTitle(device) + ": " + Format.percent(device.percentage));
    if (peripherals.length > TOOLTIP_PERIPHERALS) {
        lines.push(_("and %d more")
            .replace("%d", String(peripherals.length - TOOLTIP_PERIPHERALS)));
    }

    if (lines.length === 0)
        lines.push(_("Power Toys"));
    return lines.join("\n");
}
