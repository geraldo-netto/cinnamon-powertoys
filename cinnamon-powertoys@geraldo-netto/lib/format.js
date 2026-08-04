/*
 * cinnamon-powertoys - value formatting and UPower enum naming.
 */

const UPowerGlib = imports.gi.UPowerGlib;

const Translate = require("./lib/gettext.js");

const _ = Translate._;

const UPDeviceKind = UPowerGlib.DeviceKind;
const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

function capitalize(text) {
    if (!text)
        return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/*
 * Whether there is a number here worth writing down.
 *
 * Null is what every reading in this applet uses for "nothing to say", and
 * each of the formatters below already turned that into an empty string. What
 * none of them turned into anything was a number that is not a number:
 * toFixed answers "NaN" and "Infinity" quite happily, so a reading that
 * arrived as one drew "NaN W" in the panel and "Infinity °C" in a menu.
 *
 * Neither should reach here - lib/io.js and lib/upower.js each drop a value
 * that is not finite - which is exactly why it is worth catching in the one
 * place that would otherwise print it. A row that says nothing is a row
 * somebody reads past; a row that says NaN is a bug report about the applet
 * being broken, and it would be right.
 */
function _figure(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function percent(value, decimals) {
    if (!_figure(value))
        return "";
    return value.toFixed(decimals === undefined ? 0 : decimals) + "%";
}

function temperature(celsius, unit, decimals) {
    if (!_figure(celsius))
        return "";
    let digits = decimals === undefined ? 1 : decimals;
    if (unit === "fahrenheit")
        return (celsius * 9 / 5 + 32).toFixed(digits) + " °F";
    return celsius.toFixed(digits) + " °C";
}

function watts(value) {
    if (!_figure(value))
        return "";
    if (Math.abs(value) < 1)
        return (value * 1000).toFixed(0) + " mW";
    return value.toFixed(value < 10 ? 1 : 0) + " W";
}

function frequency(mhz) {
    if (!_figure(mhz))
        return "";
    if (mhz >= 1000)
        return (mhz / 1000).toFixed(2) + " GHz";
    return mhz.toFixed(0) + " MHz";
}

function volts(value) {
    if (!_figure(value) || value === 0)
        return "";
    return value.toFixed(2) + " V";
}

function rpm(value) {
    if (!_figure(value))
        return "";
    return value.toFixed(0) + " RPM";
}

function energy(wattHours) {
    if (!_figure(wattHours))
        return "";
    return wattHours.toFixed(1) + " Wh";
}

/* Seconds to a compact "2h 05m" / "45m" form. */
function duration(seconds) {
    if (!_figure(seconds) || seconds <= 0)
        return "";
    let minutes = Math.max(1, Math.round(seconds / 60));
    let hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    if (hours > 0)
        return hours + "h " + (minutes < 10 ? "0" : "") + minutes + "m";
    return minutes + "m";
}

function deviceKindName(kind) {
    switch (kind) {
        case UPDeviceKind.LINE_POWER: return _("AC adapter");
        case UPDeviceKind.BATTERY: return _("Battery");
        case UPDeviceKind.UPS: return _("UPS");
        case UPDeviceKind.MONITOR: return _("Monitor");
        case UPDeviceKind.MOUSE: return _("Mouse");
        case UPDeviceKind.KEYBOARD: return _("Keyboard");
        case UPDeviceKind.PDA: return _("PDA");
        case UPDeviceKind.PHONE: return _("Phone");
        case UPDeviceKind.MEDIA_PLAYER: return _("Media player");
        case UPDeviceKind.TABLET: return _("Tablet");
        case UPDeviceKind.COMPUTER: return _("Computer");
        case UPDeviceKind.GAMING_INPUT: return _("Game controller");
        case UPDeviceKind.PEN: return _("Pen");
        case UPDeviceKind.TOUCHPAD: return _("Touchpad");
        case UPDeviceKind.MODEM: return _("Modem");
        case UPDeviceKind.NETWORK: return _("Network device");
        case UPDeviceKind.HEADSET: return _("Headset");
        case UPDeviceKind.SPEAKERS: return _("Speakers");
        case UPDeviceKind.HEADPHONES: return _("Headphones");
        case UPDeviceKind.VIDEO: return _("Video device");
        case UPDeviceKind.OTHER_AUDIO: return _("Audio device");
        case UPDeviceKind.REMOTE_CONTROL: return _("Remote control");
        case UPDeviceKind.PRINTER: return _("Printer");
        case UPDeviceKind.SCANNER: return _("Scanner");
        case UPDeviceKind.CAMERA: return _("Camera");
        case UPDeviceKind.WEARABLE: return _("Wearable");
        case UPDeviceKind.TOY: return _("Toy");
        case UPDeviceKind.BLUETOOTH_GENERIC: return _("Bluetooth device");
        default:
            try {
                return capitalize(UPowerGlib.Device.kind_to_string(kind).replace(/-/g, " "));
            } catch (e) {
                return _("Device");
            }
    }
}

function deviceStateName(state) {
    switch (state) {
        case UPDeviceState.CHARGING: return _("Charging");
        case UPDeviceState.DISCHARGING: return _("Discharging");
        case UPDeviceState.EMPTY: return _("Empty");
        case UPDeviceState.FULLY_CHARGED: return _("Fully charged");
        case UPDeviceState.PENDING_CHARGE: return _("Pending charge");
        case UPDeviceState.PENDING_DISCHARGE: return _("Pending discharge");
        default: return _("Unknown");
    }
}

/* Coarse level reported by devices that cannot measure a real percentage. */
function batteryLevelName(level) {
    switch (level) {
        case UPDeviceLevel.FULL: return _("Full");
        case UPDeviceLevel.HIGH: return _("High");
        case UPDeviceLevel.NORMAL: return _("Normal");
        case UPDeviceLevel.LOW: return _("Low");
        case UPDeviceLevel.CRITICAL: return _("Critical");
        default: return _("Unknown");
    }
}

/*
 * The charge a device actually reported.
 *
 * UPower leaves Percentage at zero when a device only knows one of its
 * coarse BatteryLevel values. BatteryLevel takes precedence by contract, so
 * every caller gets the same mutually exclusive answer here instead of
 * deciding for itself whether that zero is a measurement.
 */
function batteryReading(device) {
    device = device || {};
    let level = device.batteryLevel === undefined ? UPDeviceLevel.NONE
                                                  : device.batteryLevel;
    if (level !== UPDeviceLevel.NONE) {
        return { percentage: null, level: level,
                 text: batteryLevelName(level), precise: false };
    }

    let percentage = _figure(device.percentage) ? device.percentage : null;
    return { percentage: percentage, level: UPDeviceLevel.NONE,
             text: percent(percentage), precise: percentage !== null };
}

function reportsPrecisePercentage(device) {
    return batteryReading(device).precise;
}

/*
 * Device icons, each with what to use when the first one is not installed.
 *
 * The xsi- set comes from xapp-symbolic-icons. Cinnamon's own power applet
 * only started using those names in 6.6, so on the older desktops this applet
 * supports the package is usually absent and every device row would show a
 * blank. The second name in each pair is the freedesktop one, which has been
 * in every icon theme for twenty years.
 */
var DEVICE_ICONS = {};
DEVICE_ICONS[UPDeviceKind.MONITOR] = ["xsi-video-display", "video-display"];
DEVICE_ICONS[UPDeviceKind.MOUSE] = ["xsi-input-mouse", "input-mouse"];
DEVICE_ICONS[UPDeviceKind.KEYBOARD] = ["xsi-input-keyboard", "input-keyboard"];
DEVICE_ICONS[UPDeviceKind.PHONE] = ["xsi-phone-apple-iphone", "phone"];
DEVICE_ICONS[UPDeviceKind.MEDIA_PLAYER] = ["xsi-phone-apple-iphone", "multimedia-player"];
DEVICE_ICONS[UPDeviceKind.TABLET] = ["xsi-input-tablet", "input-tablet"];
DEVICE_ICONS[UPDeviceKind.COMPUTER] = ["xsi-computer", "computer"];
DEVICE_ICONS[UPDeviceKind.GAMING_INPUT] = ["xsi-input-gaming", "input-gaming"];
DEVICE_ICONS[UPDeviceKind.TOUCHPAD] = ["xsi-input-touchpad", "input-touchpad"];
DEVICE_ICONS[UPDeviceKind.HEADSET] = ["xsi-audio-headset", "audio-headset"];
DEVICE_ICONS[UPDeviceKind.SPEAKERS] = ["xsi-audio-speakers", "audio-speakers"];
DEVICE_ICONS[UPDeviceKind.HEADPHONES] = ["xsi-audio-headphones", "audio-headphones"];
DEVICE_ICONS[UPDeviceKind.PRINTER] = ["xsi-printer", "printer"];
DEVICE_ICONS[UPDeviceKind.SCANNER] = ["xsi-scanner", "scanner"];
DEVICE_ICONS[UPDeviceKind.CAMERA] = ["xsi-camera-photo", "camera-photo"];
DEVICE_ICONS[UPDeviceKind.UPS] = ["xsi-uninterruptible-power-supply",
                                  "uninterruptible-power-supply"];

var BATTERY_ICON = ["xsi-battery-level-100", "battery-full"];

/*
 * Whether a name is in the icon theme. Only the applet can answer that, so it
 * supplies the lookup; without one every preferred name is taken on trust,
 * which is what the tests want and what an older desktop would have got
 * before this existed.
 */
let _hasIcon = null;
let _resolved = {};

function setIconLookup(lookup) {
    _hasIcon = lookup || null;
    _resolved = {};
}

/*
 * Every answer so far, thrown away.
 *
 * Whether a name is in the theme is only true of the theme that was current
 * when it was asked. Switching from a theme that carries the xapp set to one
 * that does not, or back, changes every one of these answers at once, and the
 * caller is the only thing that hears about the switch.
 */
function forgetIcons() {
    _resolved = {};
}

function iconName(pair) {
    if (!_hasIcon)
        return pair[0];
    if (_resolved[pair[0]] === undefined)
        _resolved[pair[0]] = _hasIcon(pair[0]) === true;
    return _resolved[pair[0]] ? pair[0] : pair[1];
}

/* The generic battery icon, used for anything that carries a charge and has
 * nothing more specific. */
function batteryIconName() {
    return iconName(BATTERY_ICON);
}

function deviceIconName(kind, whenUnknown) {
    let pair = DEVICE_ICONS[kind];
    if (pair)
        return iconName(pair);
    return whenUnknown === undefined ? null : whenUnknown;
}

/*
 * What a device is called: what it says it is, or what it is.
 *
 * The two halves are taken as text rather than joined as they come. Both are
 * strings by the time a device is described - lib/upower.js and lib/bluez.js
 * each default them - and a device carrying only one of them still went
 * through here as `vendor + " " + undefined`, which draws the word undefined
 * in the menu. One missing half is the ordinary case, not a broken one.
 */
function deviceTitle(device) {
    let vendor = typeof device.vendor === "string" ? device.vendor : "";
    let model = typeof device.model === "string" ? device.model : "";
    let name = (vendor + " " + model).trim();
    if (!name)
        name = deviceKindName(device.kind);
    return name;
}

var PROFILE_LABELS = {
    "power-saver": _("Power saver"),
    "balanced": _("Balanced"),
    "balanced-performance": _("Balanced performance"),
    "performance": _("Performance"),
    "quiet": _("Quiet"),
    "low-power": _("Low power"),
    "cool": _("Cool"),
};

function profileLabel(name) {
    if (!name)
        return "";
    if (PROFILE_LABELS[name])
        return PROFILE_LABELS[name];
    return capitalize(name.replace(/[-_]/g, " "));
}

/*
 * Whether this profile's icon tells it apart from the rest on offer.
 *
 * Several profiles share one: power-saver, low-power, quiet and cool all draw
 * the leaf, and performance and balanced-performance both draw the red gauge.
 * So an icon names a profile only when nothing else the machine offers draws
 * the same one - which on a power-profiles-daemon machine is always, and on a
 * firmware that offers both quiet and cool is not.
 */
function profileIconIsUnambiguous(name, available) {
    let icon = profileIconName(name);
    if (!icon)
        return false;
    return (available || []).every(other => other === name ||
                                            profileIconName(other) !== icon);
}

/*
 * Icons shipped in the applet's own icons/ directory, one per profile.
 *
 * Null for a profile this does not recognise - some firmware exports its own
 * names - so the caller shows the plain applet icon rather than pretending an
 * unknown profile is one of these three.
 */
function profileIconName(name) {
    switch (name) {
        case "power-saver":
        case "low-power":
        case "quiet":
        case "cool":
            return "powertoys-powersaver";
        case "performance":
        case "balanced-performance":
            return "powertoys-performance";
        case "balanced":
            return "powertoys-balanced";
        default:
            return null;
    }
}

/*
 * The cpufreq drivers, in words.
 *
 * "amd-pstate-epp" is what the kernel calls it and means nothing to anyone
 * who has not read the kernel documentation. The name is kept in brackets
 * because it is the thing to search for when something goes wrong, but it is
 * no longer the whole of what the row says.
 */
var DRIVER_LABELS = {
    "amd-pstate-epp": _("AMD"),
    "amd-pstate": _("AMD"),
    "acpi-cpufreq": _("ACPI"),
    "intel_pstate": _("Intel"),
    "intel_cpufreq": _("Intel, kernel managed"),
    "cppc_cpufreq": _("ACPI hardware managed"),
    "speedstep-centrino": _("Intel SpeedStep"),
    "powernow-k8": _("AMD PowerNow"),
    "pcc-cpufreq": _("Processor Clocking Control"),
};

/*
 * amd_pstate has three modes and the difference matters: "active" means the
 * hardware chooses the frequency and the energy preference is what steers it,
 * "guided" and "passive" leave more of the decision to the kernel.
 */
var PSTATE_MODES = {
    "active": _("hardware managed"),
    "guided": _("guided"),
    "passive": _("kernel managed"),
};

/*
 * "AMD (amd-pstate-epp)": whose driver it is, then the driver.
 *
 * The mode is only added where the driver's own name does not already carry
 * it. A driver ending in -epp is amd_pstate in its active mode and can be no
 * other, so "AMD, hardware managed (amd-pstate-epp)" said the same thing three
 * times in one row; plain amd-pstate is the guided or the passive mode and
 * there the word is the only way to tell which.
 */
function driverLabel(name, pstateMode) {
    if (!name)
        return _("unknown");

    let text = DRIVER_LABELS[name] || name;
    let impliedByName = /-epp$/.test(name);
    if (!impliedByName && pstateMode && PSTATE_MODES[pstateMode] &&
        text.indexOf(PSTATE_MODES[pstateMode]) < 0)
        text += ", " + PSTATE_MODES[pstateMode];
    if (text !== name)
        text += " (" + name + ")";
    return text;
}

var GOVERNOR_LABELS = {
    "performance": _("Performance"),
    "powersave": _("Power save"),
    "ondemand": _("On demand"),
    "conservative": _("Conservative"),
    "schedutil": _("Scheduler guided"),
    "userspace": _("Userspace"),
};

function governorLabel(name) {
    if (!name)
        return "";
    if (GOVERNOR_LABELS[name])
        return GOVERNOR_LABELS[name];
    return capitalize(name);
}

var EPP_LABELS = {
    "default": _("Default"),
    "performance": _("Performance"),
    "balance_performance": _("Balance performance"),
    "balance_power": _("Balance power"),
    "power": _("Power saving"),
};

function energyPreferenceLabel(name) {
    if (!name)
        return "";
    if (EPP_LABELS[name])
        return EPP_LABELS[name];
    return capitalize(name.replace(/_/g, " "));
}

/*
 * What a reading measures, in one word.
 *
 * Sensor rows sit under a heading that already names the chip they came off,
 * so a row that the driver never labelled has only to say what its number is.
 * It lives here rather than in lib/sensors.js because UPower's readings - a
 * battery's temperature, what it is drawing - are grouped the same way and
 * have to use the same words for it.
 */
var MEASURE_NAMES = {
    temperature: _("Temperature"),
    fan: _("Fan"),
    power: _("Power"),
};

function measureName(measure) {
    return MEASURE_NAMES[measure] || "";
}

/* Display name computed at discovery time, e.g. "k10temp Tctl", "drivetemp (sda)". */
function sensorLabel(sensor) {
    return sensor.display || sensor.label || sensor.chip || "";
}
