/*
 * Icon naming.
 *
 * lib/format.js is otherwise pure formatting, which PT-27b will cover. What
 * is here is the part that has to answer differently depending on the machine
 * it is running on, and so is worth pinning down: which icon name a device
 * gets when the preferred set is not installed.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Format = Harness.requireXlet("./lib/format.js");
const Gettext = imports.gettext;
const UPowerGlib = imports.gi.UPowerGlib;

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;
const Level = UPowerGlib.DeviceLevel;

/* Runs body with a stand-in icon theme that owns exactly `names`. */
function withTheme(names, body) {
    Format.setIconLookup(name => names.indexOf(name) >= 0);
    try {
        return body();
    } finally {
        Format.setIconLookup(null);
    }
}

function withNumberLocale(locale, body) {
    Format.setNumberLocale(locale);
    try {
        return body();
    } finally {
        Format.setNumberLocale(null);
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

cases["a gauge names a profile only when nothing else draws it"] = function () {
    const DAEMON = ["power-saver", "balanced", "performance"];
    for (let profile of DAEMON)
        Harness.ok(Format.profileIconIsUnambiguous(profile, DAEMON),
                   profile + " is the only one of its gauge on a daemon machine");

    /* Firmware profiles are not so tidy: these two both draw the leaf. */
    const FIRMWARE = ["quiet", "cool", "balanced", "performance"];
    Harness.equal(Format.profileIconIsUnambiguous("quiet", FIRMWARE), false,
                  "cool draws the same leaf, so the gauge does not say which");
    Harness.equal(Format.profileIconIsUnambiguous("cool", FIRMWARE), false, "and the other way");
    Harness.ok(Format.profileIconIsUnambiguous("balanced", FIRMWARE),
               "balanced is still the only one of its own");

    Harness.equal(Format.profileIconIsUnambiguous("something-new", ["something-new"]), false,
                  "a profile with no gauge at all is never named by one");
};

cases["a name is only asked about once"] = function () {
    let asked = 0;
    Format.setIconLookup(function (name) {
        asked++;
        return name === "xsi-input-mouse";
    });
    try {
        Format.deviceIconName(Kind.MOUSE);
        Format.deviceIconName(Kind.MOUSE);
        Format.deviceIconName(Kind.MOUSE);
        Harness.equal(asked, 1, "the theme is asked once and the answer kept");
    } finally {
        Format.setIconLookup(null);
    }
};

cases["a theme change is not answered from the old theme"] = function () {
    let installed = ["xsi-input-mouse"];
    Format.setIconLookup(name => installed.indexOf(name) >= 0);
    try {
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse", "the xapp set is here");

        /* The user switches to a theme without it. Nothing about the lookup
         * changed - only what it now answers. */
        installed = [];
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse",
                      "until it is told, the applet is still answering from the old theme");

        Format.forgetIcons();
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "input-mouse",
                      "and now it asks again and finds the name gone");
    } finally {
        Format.setIconLookup(null);
    }
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
                  "AMD (amd-pstate-epp)",
                  "a driver ending in -epp is the active mode and can be no other");
    Harness.equal(Format.driverLabel("amd-pstate", "passive"),
                  "AMD, kernel managed (amd-pstate)", "the mode says something here");
    Harness.equal(Format.driverLabel("amd-pstate", "guided"),
                  "AMD, guided (amd-pstate)", "and here");
    Harness.equal(Format.driverLabel("intel_pstate", null),
                  "Intel (intel_pstate)", "no pstate mode to add");
    Harness.equal(Format.driverLabel("acpi-cpufreq", null), "ACPI (acpi-cpufreq)", "acpi");
};

cases["a translation can reorder a complete scaling driver phrase"] = function () {
    let original = Gettext.dgettext;
    Gettext.dgettext = function (domain, message) {
        if (message === "%{label}, %{mode} (%{driver})")
            return "%{driver} ← %{mode} ← %{label}";
        if (message === "%{label} (%{driver})")
            return "%{driver} ← %{label}";
        return original(domain, message);
    };
    try {
        Harness.equal(Format.driverLabel("amd-pstate", "passive"),
                      "amd-pstate ← kernel managed ← AMD",
                      "the catalogue controls mode order and punctuation");
        Harness.equal(Format.driverLabel("acpi-cpufreq", null),
                      "acpi-cpufreq ← ACPI",
                      "the no-mode phrase is complete too");
    } finally {
        Gettext.dgettext = original;
    }
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

cases["every numeric unit follows the user's decimal locale"] = function () {
    withNumberLocale("de-DE", function () {
        Harness.equal(Format.number(1234.5, 1), "1234,5",
                      "the shared formatter localizes decimals without grouping");
        Harness.equal(Format.percent(42.5, 1), "42,5%", "percentage");
        Harness.equal(Format.temperature(20.25, "celsius", 2), "20,25 °C",
                      "temperature");
        Harness.equal(Format.watts(8.5), "8,5 W", "power");
        Harness.equal(Format.frequency(3500), "3,50 GHz", "frequency");
        Harness.equal(Format.volts(11.1), "11,10 V", "voltage");
        Harness.equal(Format.rpm(1367), "1367 RPM", "fan speed");
        Harness.equal(Format.energy(49.5), "49,5 Wh", "energy");
    });
};

cases["a temperature follows the unit it is given"] = function () {
    Harness.equal(Format.temperature(70.8, "celsius", 1), "70.8 °C", "celsius");
    Harness.equal(Format.temperature(70.85, "celsius", 1), "70.9 °C",
                  "locale formatting rounds the displayed decimal value");
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

cases["a translation controls each complete compact duration layout"] = function () {
    let original = Gettext.dgettext;
    Gettext.dgettext = function (domain, message) {
        if (message === "%{hours}h %{minutes}m")
            return "%{minutes} min after %{hours} hr";
        if (message === "%{minutes}m")
            return "minutes=%{minutes}";
        return original(domain, message);
    };
    try {
        Harness.equal(Format.duration(7260), "01 min after 2 hr",
                      "the locale owns the two-part order and abbreviations");
        Harness.equal(Format.duration(2700), "minutes=45",
                      "the minutes-only form is complete too");
    } finally {
        Gettext.dgettext = original;
    }
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

cases["performance degradation reasons are user-facing and future-safe"] = function () {
    Harness.equal(Format.performanceDegradedLabel("lap-detected"), "Lap detected",
                  "the documented proximity reason");
    Harness.equal(Format.performanceDegradedLabel("high-operating-temperature"),
                  "High operating temperature", "the documented thermal reason");
    Harness.equal(Format.performanceDegradedLabel("vendor_thermal-limit"),
                  "Vendor thermal limit", "a future machine token remains readable");
    Harness.equal(Format.performanceDegradedLabel(""), "", "no reason stays empty");
};

cases["known performance degradation reasons are translatable"] = function () {
    let original = Gettext.dgettext;
    Gettext.dgettext = function (domain, message) {
        return message === "Lap detected" ? "translated lap reason"
                                           : original(domain, message);
    };
    try {
        Harness.equal(Format.performanceDegradedLabel("lap-detected"),
                      "translated lap reason", "the label follows the xlet catalogue");
    } finally {
        Gettext.dgettext = original;
    }
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
    Harness.deepEqual(Format.batteryReading(
        { batteryLevel: UPowerGlib.DeviceLevel.LOW, percentage: 0 }),
        { percentage: null, level: UPowerGlib.DeviceLevel.LOW,
          text: "Low", precise: false }, "the coarse level replaces the placeholder figure");
    Harness.equal(Format.batteryReading({ percentage: 42 }).text, "42%",
                  "and an ordinary percentage remains a percentage");
};

cases["the sensor name is the one composed at discovery"] = function () {
    Harness.equal(Format.sensorLabel({ display: "k10temp Tctl", chip: "k10temp" }),
                  "k10temp Tctl", "the composed one wins");
    Harness.equal(Format.sensorLabel({ chip: "k10temp" }), "k10temp", "falling back to the chip");
    Harness.equal(Format.sensorLabel({}), "", "nothing at all");
};

/* ---------------------------------------------------------------- */
/* everything that turns a value into text                           */

/* The eight of them, each with the argument it takes. What is asserted is the
 * same of all eight, so they are a list rather than eight cases. */
const FORMATTERS = [
    { name: "percent", call: value => Format.percent(value) },
    { name: "percent, one decimal", call: value => Format.percent(value, 1) },
    { name: "temperature", call: value => Format.temperature(value, "celsius") },
    { name: "temperature in Fahrenheit", call: value => Format.temperature(value, "fahrenheit") },
    { name: "watts", call: value => Format.watts(value) },
    { name: "frequency", call: value => Format.frequency(value) },
    { name: "volts", call: value => Format.volts(value) },
    { name: "rpm", call: value => Format.rpm(value) },
    { name: "energy", call: value => Format.energy(value) },
    { name: "duration", call: value => Format.duration(value) },
];

cases["nothing to say is said as nothing"] = function () {
    /* Every reading in this applet uses null for "the machine did not answer",
     * and every one of these is drawn straight into a row. */
    for (let formatter of FORMATTERS) {
        Harness.equal(formatter.call(null), "", formatter.name + " of null");
        Harness.equal(formatter.call(undefined), "", formatter.name + " of undefined");
    }
};

cases["a number that is not a number is not printed as one"] = function () {
    /*
     * toFixed answers "NaN" and "Infinity" without complaint, so a reading
     * that arrived as one drew "NaN W" in the panel. Neither should get this
     * far - lib/io.js and lib/upower.js both drop what is not finite - which
     * is why it is worth stopping in the one place that would print it. A row
     * that says nothing is read past; a row that says NaN is a bug report, and
     * it would be right.
     */
    for (let formatter of FORMATTERS) {
        for (let value of [NaN, Infinity, -Infinity]) {
            Harness.equal(formatter.call(value), "",
                          formatter.name + " of " + value);
        }
    }
};

cases["a value that is not a number at all is not printed either"] = function () {
    for (let formatter of FORMATTERS) {
        for (let value of ["40", {}, [], true, "", "nonsense"]) {
            Harness.equal(formatter.call(value), "",
                          formatter.name + " of " + JSON.stringify(value));
        }
    }
};

cases["whatever is thrown at a formatter, it answers with readable text"] = function () {
    /*
     * The property all ten share: a string, and never one with a value's
     * insides showing. What a row draws is whatever comes back from here, and
     * there is nothing between this and the panel.
     */
    for (let formatter of FORMATTERS) {
        Fuzz.forAll({ what: formatter.name, runs: 400 },
                    random => Fuzz.value(random),
                    input => {
                        let text = Fuzz.answers(() => formatter.call(input));
                        Fuzz.isText(text, formatter.name);
                    });
    }
};

cases["a percentage that is a number is always written as one"] = function () {
    /* The other half, so the guard above cannot be tightened into refusing
     * everything: a real number still comes back as a real number. */
    Fuzz.forAll({ what: "percent", runs: 300 },
                random => random.between(-1000, 1000) / 4,
                value => {
                    let text = Format.percent(value);
                    if (!/^-?\d+%$/.test(text))
                        throw new Error("percent of " + value + " is " + JSON.stringify(text));
                });
};

cases["every device kind this applet can meet has a name"] = function () {
    /*
     * The kinds are UPower's enumeration and the switch is written out by
     * hand, so a kind added to UPower or a case dropped from the switch shows
     * up here rather than as an empty title in a menu. What is checked of each
     * is that it says something, and that what it says is not the number.
     */
    let names = {};
    for (let kind in Kind) {
        let value = Kind[kind];
        if (typeof value !== "number")
            continue;
        let name = Format.deviceKindName(value);
        Fuzz.isText(name, "the name of " + kind);
        Harness.ok(name.length > 0, kind + " has no name");
        Harness.ok(!/^\d+$/.test(name), kind + " is named after its number: " + name);
        names[kind] = name;
    }
    Harness.equal(names.MOUSE, "Mouse", "a kind the switch spells out");
    Harness.equal(names.LINE_POWER, "AC adapter", "and one it renames");
};

cases["a kind from a newer UPower still gets a name"] = function () {
    /* The default arm: UPowerGlib knows what it is called even where this
     * switch does not, and where nothing does the word Device is better than
     * an empty row. */
    for (let kind of [9999, -1, 0]) {
        let name = Format.deviceKindName(kind);
        Fuzz.isText(name, "the name of kind " + kind);
        Harness.ok(name.length > 0, "kind " + kind + " has no name");
    }
};

cases["every device state and battery level has a name"] = function () {
    for (let state in State) {
        if (typeof State[state] !== "number")
            continue;
        let name = Format.deviceStateName(State[state]);
        Fuzz.isText(name, "the name of " + state);
        Harness.ok(name.length > 0, state + " has no name");
    }
    Harness.equal(Format.deviceStateName(State.FULLY_CHARGED), "Fully charged", "spelled out");
    Harness.equal(Format.deviceStateName(9999), "Unknown", "and one it has never met");

    for (let level in Level) {
        if (typeof Level[level] !== "number")
            continue;
        Harness.ok(Format.batteryLevelName(Level[level]).length > 0, level + " has no name");
    }
    Harness.equal(Format.batteryLevelName(Level.CRITICAL), "Critical", "spelled out");
    Harness.equal(Format.batteryLevelName(9999), "Unknown", "and one it has never met");
};

cases["a name with nothing in it is capitalised to nothing"] = function () {
    Harness.equal(Format.capitalize(""), "", "an empty name");
    Harness.equal(Format.capitalize(null), "", "no name at all");
    Harness.equal(Format.capitalize("a"), "A", "one letter");
    Harness.equal(Format.capitalize("tctl"), "Tctl", "and a word");
};

cases["capitalising never loses a character"] = function () {
    /* It is the last thing done to a label the kernel wrote, so what it must
     * not do is edit one. */
    Fuzz.forAll({ what: "capitalize", runs: 400 },
                random => Fuzz.text(random),
                input => {
                    let out = Fuzz.answers(() => Format.capitalize(input));
                    Fuzz.isString(out, "capitalize");
                    if (input !== "" && out.length !== input.length)
                        throw new Error("length changed: " + JSON.stringify(out));
                    if (input !== "" && out.slice(1) !== input.slice(1))
                        throw new Error("changed more than the first letter: " +
                                        JSON.stringify(out));
                });
};

cases["a profile, governor or preference name is always readable"] = function () {
    /* Three labels that fall back to capitalising whatever the machine said,
     * and the machine says what it likes: firmware profiles are vendor words
     * and a governor can be anything a driver registered. */
    let labels = [
        { name: "profile", call: value => Format.profileLabel(value) },
        { name: "governor", call: value => Format.governorLabel(value) },
        { name: "energy preference", call: value => Format.energyPreferenceLabel(value) },
        { name: "driver", call: value => Format.driverLabel(value) },
    ];
    /*
     * A name or nothing, which is the whole of what these are ever handed: the
     * daemon's profile list is filtered to strings before it leaves
     * lib/profiles.js, the firmware's choices are words out of a file, and a
     * governor is what IO.readString gave back or null.
     */
    for (let label of labels) {
        Fuzz.forAll({ what: label.name, runs: 300 },
                    random => random.chance(4) ? random.pick([null, undefined, ""])
                                               : Fuzz.text(random),
                    input => Fuzz.isString(Fuzz.answers(() => label.call(input)), label.name));
    }
};

cases["a device title is text whatever the device says about itself"] = function () {
    Fuzz.forAll({ what: "deviceTitle", runs: 400 },
                random => ({
                    vendor: Fuzz.value(random),
                    model: Fuzz.value(random),
                    kind: random.chance(3) ? Fuzz.number(random) : random.below(30),
                }),
                device => {
                    let title = Fuzz.answers(() => Format.deviceTitle(device));
                    Fuzz.isString(title, "deviceTitle");
                    Harness.ok(title.length > 0, "a device with no name at all still needs one");
                });
};

cases["each unit changes at the value it says it changes at"] = function () {
    /*
     * The boundaries, one either side, because that is the whole of what these
     * functions decide. Written out rather than checked in the middle of a
     * range: "watts become milliwatts below one" is only a claim about one,
     * and a rule that fired at one-and-under or at nine instead would draw
     * something perfectly plausible and wrong on every desktop.
     */
    Harness.equal(Format.watts(0.9994), "999 mW", "just under a watt");
    Harness.equal(Format.watts(1), "1.0 W", "exactly one is a watt, not a thousand milliwatts");
    Harness.equal(Format.watts(0.5), "500 mW", "half a watt, in whole milliwatts");
    Harness.equal(Format.watts(0.0004), "0 mW", "and nearly nothing");
    Harness.equal(Format.watts(9.94), "9.9 W", "under ten keeps a decimal");
    Harness.equal(Format.watts(10), "10 W", "exactly ten drops it");
    Harness.equal(Format.watts(-0.5), "-500 mW", "a battery charging rather than draining");
    /* The decimal is dropped by size and not by magnitude, so a negative
     * figure keeps one however large it is. Nothing in this applet reports
     * negative watts - UPower's rate is unsigned and so are the sensors - so
     * this is what it does rather than what it was designed to do. */
    Harness.equal(Format.watts(-12.4), "-12.4 W", "and one doing it hard");

    Harness.equal(Format.frequency(999), "999 MHz", "just under a gigahertz");
    Harness.equal(Format.frequency(1000), "1.00 GHz", "exactly a thousand megahertz is one");
    Harness.equal(Format.frequency(9999), "10.00 GHz", "and the divisor is a thousand");
    Harness.equal(Format.frequency(4300), "4.30 GHz", "the figure the panel used to show");

    Harness.equal(Format.duration(0), "", "no time at all");
    Harness.equal(Format.duration(-60), "", "and none of the other kind");
    Harness.equal(Format.duration(30), "1m", "rounded to the nearest minute");
    Harness.equal(Format.duration(3599), "1h 00m", "a minute short of an hour rounds into one");
    Harness.equal(Format.duration(3600), "1h 00m", "exactly an hour is an hour, not sixty minutes");
    Harness.equal(Format.duration(3540), "59m", "and a minute under it is not");
    Harness.equal(Format.duration(3600 + 9 * 60), "1h 09m", "single minutes keep their nought");
    Harness.equal(Format.duration(3600 + 10 * 60), "1h 10m", "and ten does not gain one");

    Harness.equal(Format.duration(1), "1m",
                  "positive time never claims that no minutes remain");
    Harness.equal(Format.temperature(40, "celsius"), "40.0 °C",
                  "a temperature carries one decimal unless asked for another");
    Harness.equal(Format.temperature(40, "celsius", 0), "40 °C", "and this is asking");

    Harness.equal(Format.percent(0), "0%", "flat");
    Harness.equal(Format.percent(100), "100%", "full");
    Harness.equal(Format.volts(0), "", "a voltage of nought is a device not reporting one");
    Harness.equal(Format.volts(0.004), "0.00 V", "and a real one that small still reports");
    Harness.equal(Format.rpm(0), "0 RPM", "a fan that is stopped is a reading");
    Harness.equal(Format.energy(0), "0.0 Wh", "and so is an empty battery");
};

cases["a profile with no icon of its own says so rather than answering nothing"] = function () {
    /*
     * The default arm of the switch. It answers null on purpose - the caller
     * shows the plain applet icon rather than dressing an unknown firmware
     * profile up as one of the three - and a switch that fell through to
     * undefined instead would read the same everywhere except here.
     */
    Harness.equal(Format.profileIconName("cool"), "powertoys-powersaver", "a name it knows");
    Harness.ok(Format.profileIconName("vendor-turbo") === null,
               "null, and not undefined, for one it does not");
    Harness.ok(Format.profileIconName(undefined) === null, "nor for nothing at all");
};

cases["the pstate mode is added once, and only where it says something"] = function () {
    /*
     * The check that the driver's own name does not already carry the mode.
     * amd-pstate-epp is the active mode and can be no other, so
     * "AMD, hardware managed (amd-pstate-epp)" says it three times; the guard
     * that stops the second one is a search for the words already being there.
     */
    Harness.equal(Format.driverLabel("amd-pstate", "active"),
                  "AMD, hardware managed (amd-pstate)",
                  "a driver whose name does not carry the mode gets it");
    Harness.equal(Format.driverLabel("amd-pstate-epp", "active"), "AMD (amd-pstate-epp)",
                  "and one whose name does, does not");

    /* The same words twice is what the search exists to prevent, so a label
     * that already contains them must not gain them again. */
    /* The search asks whether the words are there at all, not whether they are
     * there after the start. A driver whose whole name is a mode word is the
     * only place those two differ, and it is the kind of name a vendor's
     * out-of-tree driver arrives with. */
    Harness.equal(Format.driverLabel("guided", "guided"), "guided",
                  "the mode is already the whole of what this driver is called");

    let twice = Format.driverLabel("amd-pstate", "active");
    Harness.equal(twice.indexOf("hardware managed"), twice.lastIndexOf("hardware managed"),
                  "the mode appears once: " + twice);
};

/*
 * The name a reading row gives itself.
 *
 * Two labels in a row are a layout; a screen reader needs a sentence. What is
 * worth pinning down is the joining and, more, the two edges - a heading whose
 * value has not arrived yet must not be read out with a colon and nothing
 * after it, and a value with no label must still be readable.
 */
cases["a reading names itself with its label and its value"] = function () {
    Harness.equal(Format.readingName("Battery", "84%"), "Battery: 84%",
                  "both halves are said, in order, as one name");
};

cases["either half of a reading is a complete name on its own"] = function () {
    Harness.equal(Format.readingName("Governor", ""), "Governor",
                  "a heading before its value has arrived is not \"Governor: \"");
    Harness.equal(Format.readingName("Governor", null), "Governor",
                  "an absent value is the same as an empty one");
    Harness.equal(Format.readingName("", "84%"), "84%",
                  "and a value with no label is still worth reading");
    Harness.equal(Format.readingName(null, undefined), "",
                  "a row with nothing to say says nothing");
};

cases["the joining between a label and its value is translatable"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/lib/format.js");
    Harness.ok(source.indexOf('_("%{label}: %{value}")') >= 0,
               "what goes between the two is not a colon in every language");
    Harness.ok(source.indexOf('Translate.interpolate(_("%{label}: %{value}")') >= 0,
               "and it is substituted rather than concatenated");
};
