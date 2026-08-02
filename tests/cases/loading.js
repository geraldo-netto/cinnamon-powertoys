/*
 * The libraries load, and offer what the applet reaches for.
 *
 * This is the case that earns the harness: it loads each module exactly as
 * Cinnamon does and checks the names applet.js uses are all there. A rename
 * that a parse check cannot see - the file is still valid JavaScript - shows
 * up here as a missing export.
 */

const Harness = imports.harness;

var cases = {};

const MODULES = ["io", "log", "gettext", "format", "device", "sensors", "cpu",
                 "power-supply", "upower", "profiles", "backlight", "ddc", "bluez"];

for (let name of MODULES) {
    cases["lib/" + name + ".js loads"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        Harness.ok(module, name + " returned nothing");
    };
}

/* Everything applet.js names on a library, listed here so a rename in either
 * place is a failure rather than an undefined at the point of use. */
const USED = {
    "io": ["readNumber", "exists", "readString", "readWords", "readLink",
           "listDir", "setRoot", "resolve", "naturalCompare", "isReadable"],
    "log": ["error", "setSink"],
    "gettext": ["_", "UUID"],
    "format": ["deviceTitle", "sensorLabel", "temperature", "watts", "percent",
               "batteryIconName", "setIconLookup", "DEVICE_ICONS",
               "frequency", "rpm", "volts", "energy", "duration", "profileLabel",
               "profileIconName", "governorLabel", "energyPreferenceLabel",
               "deviceKindName", "deviceStateName", "batteryLevelName",
               "deviceIconName", "reportsPrecisePercentage"],
    "sensors": ["SensorSet", "EnergyMeter", "discoverSensors", "discoverEnergyCounters",
                "isPrimaryKind", "bySensorOrder", "kindLabel", "classifyChip", "KINDS",
                "sensorMatches"],
    "device": ["isDraining", "lowThreshold", "remainingText", "describe",
               "title", "iconName", "viewModel"],
    "cpu": ["CpuControl"],
    "power-supply": ["discoverChargeControl", "platformProfile", "ChargeControl"],
    "upower": ["UPowerMonitor"],
    "profiles": ["PowerProfilesClient", "PROFILE_ORDER"],
    "backlight": ["BacklightControl", "SCREEN", "KEYBOARD"],
    "ddc": ["DdcBacklight", "parseDisplays", "parseBrightness"],
    "bluez": ["BluezBatteries", "parseObjects", "addressOf"],
};

for (let name in USED) {
    cases["lib/" + name + ".js exports what the applet uses"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        for (let symbol of USED[name])
            Harness.ok(module[symbol] !== undefined && module[symbol] !== null,
                       name + "." + symbol + " is missing");
    };
}

cases["the libraries load without a shell"] = function () {
    /* lib/log.js exists so that nothing in lib/ touches Cinnamon's globals at
     * load time. If something starts to, this is where it shows. */
    Harness.equal(typeof globalThis.global, "undefined",
                  "a library defined a shell global just by being loaded");
};
