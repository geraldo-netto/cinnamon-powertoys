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

const UPowerGlib = imports.gi.UPowerGlib;

const PowerSupply = require("./lib/power-supply.js");
const Format = require("./lib/format.js");
const Sensors = require("./lib/sensors.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const UPDeviceState = UPowerGlib.DeviceState;

/*
 * What the common processor drivers call the reading that stands for the whole
 * package: AMD's Tctl and Tdie, Intel's "Package id 0", and the SoC thermal
 * zones that have only a type. In order of preference.
 */
var PREFERRED_CPU_SENSORS = ["tctl", "tdie", "package id 0", "cpu"];

/*
 * The power figure is not one thing: on battery it is what the battery is
 * losing, on a desktop it is the CPU package or the graphics card. They are
 * different enough that showing the number without saying which would be
 * misleading, so the source is always named alongside it.
 */
function powerSourceLabel(source) {
    switch (source) {
        case "battery": return _("battery");
        case "platform": return _("platform total");
        case "package": return _("package");
        case "gpu": return _("GPU");
        default: return "";
    }
}

function powerText(data) {
    if (data.systemWatts === null)
        return "";
    let label = powerSourceLabel(data.systemWattsSource);
    let power = Format.watts(data.systemWatts);
    return label ? Translate.interpolate(_("%{power} (%{source})"),
        { power: power, source: label }) : power;
}

/*
 * The same figure for the panel, where every character is expensive.
 *
 * What a battery is losing is the whole machine and needs no explanation. The
 * Other sources say what they measure. A processor package and a graphics
 * card are only components, while a DTPM aggregate is a platform total with a
 * materially different source from the battery estimate. A bare number would
 * erase those distinctions.
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
 * next - two settings are controls or not offered at all depending on it -
 * which is why it is worth being a named function with cases behind it rather
 * than a condition written out where it is asked.
 */
function profileOwnsGovernor(data) {
    return data.profile.available && !!data.profile.backend &&
           data.profile.backend !== PowerSupply.PLATFORM_BACKEND;
}

/* Daemon profiles are ordinary session D-Bus writes. The ACPI fallback is a
 * root-owned sysfs node and follows the user's privileged-control setting. */
function profileCanChange(data, privileged) {
    return data.profile.available &&
           (data.profile.backend !== PowerSupply.PLATFORM_BACKEND || !!privileged);
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
            return Translate.interpolate(_("Governor: %{governor}"),
                { governor: Format.governorLabel(args[1]) });
        case "epp":
            return Translate.interpolate(_("Energy preference: %{preference}"),
                { preference: Format.energyPreferenceLabel(args[1]) });
        case "boost":
            return String(args[1]) === "1" ? _("Turbo boost on") : _("Turbo boost off");
        case "charge-threshold":
            return Translate.interpolate(_("Charge limit: %{limit}"),
                { limit: Format.percent(Number(args[1])) });
        default:
            return "";
    }
}

/*
 * The sensor the machine is judged by: the user's hint first, then the one a
 * CPU calls its own, then a GPU, then whatever is left.
 *
 * This one number is the panel tooltip's temperature and the number the high
 * temperature alert fires against, so which sensor it comes off decides
 * whether the alert is about the processor or about a disk.
 *
 * Matching is on what the driver calls the sensor, not on the name the menu
 * shows, which is composed for reading and could be composed differently
 * tomorrow. The settings tooltip says "chip or label fragment", and that is
 * literally what is compared.
 *
 * `hintMatched` answers a question only the menu asks: true where the user's
 * hint chose the sensor, false where they set one and nothing matched - which
 * is worth saying out loud, since there is no other way to find out a typed
 * name was ignored - and null where they set none.
 */
function pickTemperature(temperatures, hint) {
    let wanted = (hint || "").trim();
    let readable = temperatures.filter(sensor => sensor.celsius !== null);
    if (readable.length === 0)
        return { sensor: null, hintMatched: null };

    if (wanted) {
        let match = readable.find(sensor => Sensors.sensorMatches(sensor, wanted));
        if (match)
            return { sensor: match, hintMatched: true };
    }

    let matched = wanted === "" ? null : false;
    let cpus = readable.filter(sensor => sensor.kind === "cpu");
    for (let name of PREFERRED_CPU_SENSORS) {
        let match = cpus.find(sensor => Sensors.sensorMatches(sensor, name));
        if (match)
            return { sensor: match, hintMatched: matched };
    }
    if (cpus.length > 0)
        return { sensor: cpus[0], hintMatched: matched };

    let gpu = readable.find(sensor => sensor.kind === "gpu");
    return { sensor: gpu || readable[0], hintMatched: matched };
}

/*
 * Which of several numbers counts as the machine's power draw.
 *
 * Battery drain is the honest number while on battery; otherwise a DTPM
 * platform aggregate, the RAPL package counter, and finally one declared
 * whole-device total per GPU. Raw hwmon channels and DTPM children are not
 * added here: their relationship is driver-specific or already represented
 * by a parent. The source is reported alongside the value because these
 * measure very different things - see powerText, which is what says so to the
 * user.
 */
function pickPower(primary, packageWatts, powers) {
    if (primary && primary.state === UPDeviceState.DISCHARGING && primary.energyRate)
        return { watts: primary.energyRate, source: "battery" };
    let platform = powers.filter(entry => entry.platformTotal && entry.watts !== null);
    if (platform.length > 0)
        return { watts: platform.reduce((total, entry) => total + entry.watts, 0),
                 source: "platform" };
    if (packageWatts !== null)
        return { watts: packageWatts, source: "package" };
    let gpus = new Map();
    for (let entry of powers) {
        if (entry.kind !== "gpu" || !entry.deviceTotal || !Number.isFinite(entry.watts))
            continue;
        let group = entry.group || entry.id;
        if (group && !gpus.has(group))
            gpus.set(group, entry.watts);
    }
    if (gpus.size > 0)
        return { watts: Array.from(gpus.values()).reduce((total, watts) => total + watts, 0),
                 source: "gpu" };
    return { watts: null, source: null };
}
