/*
 * cinnamon-powertoys - what the panel says about a reading.
 *
 * The text beside the icon, the grouped tooltip, and which of the
 * three things the icon is drawn from. Each is a function of one reading and
 * the options in force; none of them touches the panel, which is why they are
 * out here where they can be asked.
 *
 * They were methods on the panel presenter in applet.js, which cannot be
 * loaded outside Cinnamon - so the rules in them, and they are rules rather
 * than formatting, went unexercised: when a profile is worth saying in words
 * beside a gauge that already says it, how component consumption is named
 * without passing it off as a whole-machine total, and what a machine with
 * nothing to report says.
 */

const UPowerGlib = imports.gi.UPowerGlib;

const Device = require("./lib/device.js");
const Format = require("./lib/format.js");
const Reading = require("./lib/reading.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

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
    if (options.showBattery && data.primary) {
        let charge = Format.batteryReading(data.primary).text;
        if (charge)
            parts.push(charge);
    }
    if (options.showPower && data.systemWatts !== null)
        parts.push(Reading.panelPowerText(data));
    if (options.showProfile && profileNeedsSpelling(data, source, profile))
        parts.push(Format.profileLabel(profile));
    /* Three figures about three different things, joined by a space, read
     * as one string: "97% 12 W Balanced". The dot is what says where each
     * of them ends, and it is the one the menu's own summary line uses for
     * the same job. */
    return parts.join(" · ");
}

/* With no primary device there is no battery row to imply the source. The
 * UPower manager's OnBattery property is authoritative even when it could not
 * compose a display device; without that manager, neither AC nor battery is a
 * safe assumption. */
function powerStatusLabel(data) {
    if (!data.upowerAvailable)
        return _("Power status unavailable");
    return data.onBattery ? _("On battery power") : _("On AC power");
}

function powerStatusTooltip(data) {
    if (!data.upowerAvailable)
        return _("Power status unavailable");
    return _("Power source") + ": " + (data.onBattery ? _("Battery") : "AC");
}

/* A section of the tooltip, separated from the one before it and indented so
 * its title and values remain recognisable in a plain-text Cinnamon tooltip.
 * Empty sections take no space. */
function appendSection(lines, title, entries) {
    if (entries.length === 0)
        return;
    if (lines.length > 0)
        lines.push("");
    lines.push(title);
    for (let entry of entries)
        lines.push("  " + entry);
}

/* Charge, state and time, without an "Unknown" that says nothing. */
function deviceStatus(device) {
    let parts = [Format.batteryReading(device).text];
    if (device.state !== undefined && device.state !== UPowerGlib.DeviceState.UNKNOWN)
        parts.push(Format.deviceStateName(device.state));
    parts.push(Device.remainingText(device));
    return parts.filter(part => part !== "").join(" · ");
}

function namedStatus(name, device) {
    let status = deviceStatus(device);
    return name + (status ? ": " + status : "");
}

/*
 * Every consumption figure the tooltip can identify honestly.
 *
 * Battery discharge is the closest thing available here to a whole-machine
 * reading. RAPL is a processor-package total, and an hwmon meter belongs to
 * the processor or graphics device that exported it. They are deliberately
 * separate entries: adding them can double-count components, and calling any
 * one of them simply "Power draw" promoted a GPU reading to a system total.
 */
function consumptionEntries(data) {
    let entries = [];
    if (data.systemWattsSource === "battery" && data.systemWatts !== null)
        entries.push(_("Whole system (battery)") + ": " + Format.watts(data.systemWatts));
    if (data.packageWatts !== undefined && data.packageWatts !== null)
        entries.push(_("Processor package total") + ": " + Format.watts(data.packageWatts));

    let meters = (data.powers || []).filter(meter =>
        (meter.kind === "cpu" || meter.kind === "gpu") && meter.watts !== null);
    let counts = {};
    for (let meter of meters) {
        let group = meter.group || meter.groupLabel || meter.label;
        counts[group] = (counts[group] || 0) + 1;
    }
    for (let meter of meters) {
        let group = meter.group || meter.groupLabel || meter.label;
        let name = meter.groupLabel || meter.label ||
                   (meter.kind === "gpu" ? _("Graphics") : _("Processor"));
        if (counts[group] > 1 && meter.shortLabel)
            name += " — " + meter.shortLabel;
        entries.push(name + ": " + Format.watts(meter.watts));
    }
    return entries;
}

function performanceEntries(data, options) {
    let entries = [];
    let profile = Reading.shownProfile(data, options);
    if (profile)
        entries.push(_("Profile") + ": " + Format.profileLabel(profile));
    if (data.cpu.governor)
        entries.push(_("Governor") + ": " + Format.governorLabel(data.cpu.governor));

    let current = Format.frequency(data.cpu.averageFrequency);
    let maximum = Format.frequency(data.cpu.maxFrequency);
    let processor = [];
    if (current)
        processor.push(current);
    if (maximum)
        processor.push(_("maximum %s").replace("%s", maximum));
    if (processor.length > 0)
        entries.push(_("Processor") + ": " + processor.join(" · "));
    if (data.cpuTemperature !== null)
        entries.push(_("Temperature") + ": " +
                     Format.temperature(data.cpuTemperature, options.tempUnit, 1));
    return entries;
}

/* Chargers and every charge-carrying device, without silently discarding
 * devices that report no percentage. The primary above is UPower's composite
 * display battery on most machines; the physical batteries remain devices of
 * their own here, as they are in the menu. */
function deviceEntries(data) {
    let entries = (data.lines || []).map(line =>
        Format.deviceTitle(line) + ": " + (line.online ? _("Connected") : _("Disconnected")));
    for (let device of data.devices || [])
        entries.push(namedStatus(Format.deviceTitle(device), device));
    return entries;
}

function tooltipText(data, options) {
    let lines = [powerStatusTooltip(data)];

    if (data.primary)
        lines.push(namedStatus(Format.deviceKindName(data.primary.kind), data.primary));

    appendSection(lines, _("Consumption"), consumptionEntries(data));
    appendSection(lines, _("Performance"), performanceEntries(data, options));
    appendSection(lines, _("Devices"), deviceEntries(data));
    return lines.join("\n");
}
