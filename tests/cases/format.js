/*
 * Icon naming.
 *
 * lib/format.js is otherwise pure formatting, which PT-27b will cover. What
 * is here is the part that has to answer differently depending on the machine
 * it is running on, and so is worth pinning down: which icon name a device
 * gets when the preferred set is not installed.
 */

const Harness = imports.harness;

const Format = Harness.requireXlet("./lib/format.js");
const UPowerGlib = imports.gi.UPowerGlib;

const Kind = UPowerGlib.DeviceKind;

/* Runs body with a stand-in icon theme that owns exactly `names`. */
function withTheme(names, body) {
    Format.setIconLookup(name => names.indexOf(name) >= 0);
    try {
        return body();
    } finally {
        Format.setIconLookup(null);
    }
}

var cases = {};

cases["the xapp icons are used where they are installed"] = function () {
    withTheme(["xsi-input-mouse", "xsi-battery-level-100"], function () {
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse", "mouse");
        Harness.equal(Format.batteryIconName(), "xsi-battery-level-100", "battery");
    });
};

cases["a desktop without them falls back to the freedesktop names"] = function () {
    withTheme([], function () {
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "input-mouse", "mouse");
        Harness.equal(Format.deviceIconName(Kind.KEYBOARD), "input-keyboard", "keyboard");
        Harness.equal(Format.deviceIconName(Kind.UPS), "uninterruptible-power-supply", "ups");
        Harness.equal(Format.deviceIconName(Kind.GAMING_INPUT), "input-gaming", "controller");
        Harness.equal(Format.batteryIconName(), "battery-full", "battery");
    });
};

cases["every device icon has a fallback that is not an xapp name"] = function () {
    withTheme([], function () {
        for (let kind in Format.DEVICE_ICONS) {
            let fallback = Format.DEVICE_ICONS[kind][1];
            Harness.ok(fallback, "kind " + kind + " has no fallback");
            Harness.equal(fallback.indexOf("xsi-"), -1,
                          "kind " + kind + " falls back to another xapp name: " + fallback);
        }
        Harness.equal(Format.BATTERY_ICON[1].indexOf("xsi-"), -1, "the battery fallback");
    });
};

cases["with no icon theme to ask, the preferred name is used"] = function () {
    Format.setIconLookup(null);
    Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse",
                  "nothing to check against, so no reason to give up the better name");
};

cases["an unknown kind gets whatever the caller offered"] = function () {
    withTheme([], function () {
        Harness.equal(Format.deviceIconName(Kind.MODEM, null), null, "no default asked for");
        Harness.equal(Format.deviceIconName(Kind.MODEM, "battery-full"), "battery-full", "one was");
    });
};

cases["the theme is asked once per name, not once per row"] = function () {
    let asked = 0;
    Format.setIconLookup(function (name) {
        asked++;
        return false;
    });
    try {
        for (let i = 0; i < 10; i++)
            Format.deviceIconName(Kind.MOUSE);
        Harness.equal(asked, 1, "ten rows, one lookup");
    } finally {
        Format.setIconLookup(null);
    }
};

cases["a profile this applet has no icon for gets none"] = function () {
    Harness.equal(Format.profileIconName("power-saver"), "powertoys-powersaver", "power saver");
    Harness.equal(Format.profileIconName("balanced"), "powertoys-balanced", "balanced");
    Harness.equal(Format.profileIconName("performance"), "powertoys-performance", "performance");
    Harness.equal(Format.profileIconName("quiet"), "powertoys-powersaver",
                  "firmware names that mean the same thing");
    Harness.equal(Format.profileIconName("something-a-vendor-invented"), null,
                  "rather than dressing it up as one of the three");
    Harness.equal(Format.profileIconName(null), null, "nothing active");
};

cases["a scaling driver is named in words, with the kernel's own name kept"] = function () {
    Harness.equal(Format.driverLabel("amd-pstate-epp", "active"),
                  "AMD, hardware managed  (amd-pstate-epp)",
                  "the mode is already in the label, so it is not repeated");
    Harness.equal(Format.driverLabel("amd-pstate", "passive"),
                  "AMD, kernel managed  (amd-pstate)", "the mode says something here");
    Harness.equal(Format.driverLabel("intel_pstate", null),
                  "Intel  (intel_pstate)", "no pstate mode to add");
    Harness.equal(Format.driverLabel("acpi-cpufreq", null), "ACPI  (acpi-cpufreq)", "acpi");
};

cases["a driver nobody has heard of is shown as it is"] = function () {
    Harness.equal(Format.driverLabel("brand-new-driver", null), "brand-new-driver",
                  "not dressed up, and not repeated in brackets either");
    Harness.equal(Format.driverLabel(null, null), "unknown", "no driver at all");
};

/* ---------------------------------------------------------------- */
/* units                                                             */

cases["a percentage is whole unless asked otherwise"] = function () {
    Harness.equal(Format.percent(42), "42%", "whole");
    Harness.equal(Format.percent(42.4), "42%", "rounded");
    Harness.equal(Format.percent(42.44, 1), "42.4%", "one place when asked");
    Harness.equal(Format.percent(null), "", "nothing to show");
    Harness.equal(Format.percent(undefined), "", "still nothing");
};

cases["a temperature follows the unit it is given"] = function () {
    Harness.equal(Format.temperature(70.8, "celsius", 1), "70.8 °C", "celsius");
    /* toFixed rounds the binary value, not the decimal one, so 70.85 goes
     * down. Worth pinning: it is the sort of thing a rewrite would "fix"
     * into a different set of readings. */
    Harness.equal(Format.temperature(70.85, "celsius", 1), "70.8 °C", "a value that lands on a half");
    Harness.equal(Format.temperature(0, "fahrenheit", 1), "32.0 °F", "freezing");
    Harness.equal(Format.temperature(100, "fahrenheit", 0), "212 °F", "boiling");
    Harness.equal(Format.temperature(70.85, "celsius", 0), "71 °C", "no decimals");
    Harness.equal(Format.temperature(null, "celsius"), "", "no reading");
};

cases["watts become milliwatts below one"] = function () {
    Harness.equal(Format.watts(64), "64 W", "a graphics card");
    Harness.equal(Format.watts(9.44), "9.4 W", "one place under ten, where it matters");
    Harness.equal(Format.watts(0.35), "350 mW", "a mouse");
    Harness.equal(Format.watts(0), "0 mW", "nothing being drawn");
    Harness.equal(Format.watts(null), "", "nothing measured");
};

cases["frequency becomes gigahertz at a thousand"] = function () {
    Harness.equal(Format.frequency(3500), "3.50 GHz", "gigahertz");
    Harness.equal(Format.frequency(999), "999 MHz", "just under");
    Harness.equal(Format.frequency(1000), "1.00 GHz", "exactly at");
    Harness.equal(Format.frequency(null), "", "not known");
};

cases["the small units say what they are"] = function () {
    Harness.equal(Format.volts(11.1), "11.10 V", "volts");
    Harness.equal(Format.volts(0), "", "zero volts is not a reading");
    Harness.equal(Format.rpm(1367), "1367 RPM", "a fan");
    Harness.equal(Format.rpm(0), "0 RPM", "a fan that has stopped is a reading");
    Harness.equal(Format.energy(49.94), "49.9 Wh", "energy");
};

cases["a duration is hours and minutes, or just minutes"] = function () {
    Harness.equal(Format.duration(7200), "2h 00m", "two hours, padded");
    Harness.equal(Format.duration(7260), "2h 01m", "and one minute");
    Harness.equal(Format.duration(5400), "1h 30m", "an hour and a half");
    Harness.equal(Format.duration(2700), "45m", "under an hour");
    Harness.equal(Format.duration(30), "1m", "rounded up to a minute");
    Harness.equal(Format.duration(0), "", "no estimate");
    Harness.equal(Format.duration(-60), "", "and nothing negative");
};

/* ---------------------------------------------------------------- */
/* names                                                             */

cases["the profile and governor names are translated where known"] = function () {
    Harness.equal(Format.profileLabel("power-saver"), "Power saver", "known");
    Harness.equal(Format.profileLabel("balanced-performance"), "Balanced performance", "known");
    Harness.equal(Format.profileLabel("vendor-turbo"), "Vendor turbo",
                  "unknown, tidied rather than left as an identifier");
    Harness.equal(Format.profileLabel(null), "", "none active");

    Harness.equal(Format.governorLabel("schedutil"), "Scheduler guided", "known");
    Harness.equal(Format.governorLabel("whatever"), "Whatever", "unknown");
    Harness.equal(Format.energyPreferenceLabel("balance_power"), "Balance power", "known");
    Harness.equal(Format.energyPreferenceLabel("some_new_one"), "Some new one",
                  "unknown, with the underscores taken out");
};

cases["a device is named by vendor and model, or by what it is"] = function () {
    Harness.equal(Format.deviceTitle({ vendor: "Logitech", model: "MX", kind: Kind.MOUSE }),
                  "Logitech MX", "both");
    Harness.equal(Format.deviceTitle({ vendor: "", model: "BW01", kind: Kind.HEADSET }),
                  "BW01", "model only");
    Harness.equal(Format.deviceTitle({ vendor: "", model: "", kind: Kind.MOUSE }),
                  "Mouse", "neither, so say what it is");
};

cases["a device that cannot measure itself is described in words"] = function () {
    Harness.equal(Format.batteryLevelName(UPowerGlib.DeviceLevel.LOW), "Low", "low");
    Harness.equal(Format.batteryLevelName(UPowerGlib.DeviceLevel.CRITICAL), "Critical", "critical");
    Harness.equal(Format.reportsPrecisePercentage(
        { batteryLevel: UPowerGlib.DeviceLevel.NONE, percentage: 42 }), true, "a real percentage");
    Harness.equal(Format.reportsPrecisePercentage(
        { batteryLevel: UPowerGlib.DeviceLevel.LOW, percentage: 42 }), false,
        "a coarse level, whatever number came with it");
};

cases["the sensor name is the one composed at discovery"] = function () {
    Harness.equal(Format.sensorLabel({ display: "k10temp Tctl", chip: "k10temp" }),
                  "k10temp Tctl", "the composed one wins");
    Harness.equal(Format.sensorLabel({ chip: "k10temp" }), "k10temp", "falling back to the chip");
    Harness.equal(Format.sensorLabel({}), "", "nothing at all");
};
