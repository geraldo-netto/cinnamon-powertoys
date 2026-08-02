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

function percent(value, decimals) {
    if (value === null || value === undefined)
        return "";
    return value.toFixed(decimals === undefined ? 0 : decimals) + "%";
}

function temperature(celsius, unit, decimals) {
    if (celsius === null || celsius === undefined)
        return "";
    let digits = decimals === undefined ? 1 : decimals;
    if (unit === "fahrenheit")
        return (celsius * 9 / 5 + 32).toFixed(digits) + " °F";
    return celsius.toFixed(digits) + " °C";
}

function watts(value) {
    if (value === null || value === undefined)
        return "";
    if (Math.abs(value) < 1)
        return (value * 1000).toFixed(0) + " mW";
    return value.toFixed(value < 10 ? 1 : 0) + " W";
}

function frequency(mhz) {
    if (mhz === null || mhz === undefined)
        return "";
    if (mhz >= 1000)
        return (mhz / 1000).toFixed(2) + " GHz";
    return mhz.toFixed(0) + " MHz";
}

function volts(value) {
    if (value === null || value === undefined || value === 0)
        return "";
    return value.toFixed(2) + " V";
}

function rpm(value) {
    if (value === null || value === undefined)
        return "";
    return value.toFixed(0) + " RPM";
}

function energy(wattHours) {
    if (wattHours === null || wattHours === undefined)
        return "";
    return wattHours.toFixed(1) + " Wh";
}

/* Seconds to a compact "2h 05m" / "45m" form. */
function duration(seconds) {
    if (!seconds || seconds <= 0)
        return "";
    let minutes = Math.round(seconds / 60);
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

function reportsPrecisePercentage(device) {
    return device.batteryLevel === UPDeviceLevel.NONE && device.percentage !== null;
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

function deviceTitle(device) {
    let name = "";
    if (device.vendor || device.model)
        name = (device.vendor + " " + device.model).trim();
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
 * Icons shipped in the applet's own icons/ directory, one per profile.
 *
 * Null for a profile this does not recognise - some firmware exports its own
 * names - so the caller shows the plain applet icon rather than pretending an
 * unknown profile is one of these three.
 */
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
    "amd-pstate-epp": _("AMD, hardware managed"),
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

function driverLabel(name, pstateMode) {
    if (!name)
        return _("unknown");

    let text = DRIVER_LABELS[name] || name;
    /* Only worth adding where it says something the driver name does not. */
    if (pstateMode && PSTATE_MODES[pstateMode] &&
        text.indexOf(PSTATE_MODES[pstateMode]) < 0)
        text += ", " + PSTATE_MODES[pstateMode];
    if (text !== name)
        text += "  (" + name + ")";
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
