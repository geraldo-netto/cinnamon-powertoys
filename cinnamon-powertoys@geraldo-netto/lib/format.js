/*
 * cinnamon-powertoys - value formatting and UPower enum naming.
 */

const GLib = imports.gi.GLib;
const Gettext = imports.gettext;
const UPowerGlib = imports.gi.UPowerGlib;

const UUID = "cinnamon-powertoys@geraldo-netto";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    let translated = Gettext.dgettext(UUID, text);
    if (translated !== text)
        return translated;
    return Gettext.gettext(text);
}

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

function deviceIconName(kind, fallback) {
    switch (kind) {
        case UPDeviceKind.MONITOR: return "xsi-video-display";
        case UPDeviceKind.MOUSE: return "xsi-input-mouse";
        case UPDeviceKind.KEYBOARD: return "xsi-input-keyboard";
        case UPDeviceKind.PHONE:
        case UPDeviceKind.MEDIA_PLAYER: return "xsi-phone-apple-iphone";
        case UPDeviceKind.TABLET: return "xsi-input-tablet";
        case UPDeviceKind.COMPUTER: return "xsi-computer";
        case UPDeviceKind.GAMING_INPUT: return "xsi-input-gaming";
        case UPDeviceKind.TOUCHPAD: return "xsi-input-touchpad";
        case UPDeviceKind.HEADSET: return "xsi-audio-headset";
        case UPDeviceKind.SPEAKERS: return "xsi-audio-speakers";
        case UPDeviceKind.HEADPHONES: return "xsi-audio-headphones";
        case UPDeviceKind.PRINTER: return "xsi-printer";
        case UPDeviceKind.SCANNER: return "xsi-scanner";
        case UPDeviceKind.CAMERA: return "xsi-camera-photo";
        case UPDeviceKind.UPS: return "xsi-uninterruptible-power-supply";
        default: return fallback || "xsi-battery-level-100";
    }
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

/* Icons shipped in the applet's icons/ directory. */
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
            return "powertoys";
    }
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

var SENSOR_KIND_LABELS = {
    "cpu": _("Processor"),
    "gpu": _("Graphics"),
    "disk": _("Storage"),
    "network": _("Network"),
    "board": _("Mainboard"),
    "battery": _("Battery"),
    "other": _("Other"),
};

function sensorKindLabel(kind) {
    return SENSOR_KIND_LABELS[kind] || SENSOR_KIND_LABELS["other"];
}

/* Display name computed at discovery time, e.g. "k10temp Tctl", "drivetemp (sda)". */
function sensorLabel(sensor) {
    return sensor.display || sensor.label || sensor.chip || "";
}
