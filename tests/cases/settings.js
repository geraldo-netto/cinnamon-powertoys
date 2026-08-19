/*
 * The settings schema and the table of them, against each other.
 *
 * The one thing worth checking here is that the two lists have not drifted: a
 * key in the schema and not in the table is a setting the user can change and
 * the applet never reads, and a key in the table and not in the schema binds to
 * nothing and leaves its property undefined.
 *
 * The table used to be in applet.js, which imports the shell at its first line
 * and cannot be loaded outside Cinnamon, so these cases read it as text with a
 * regular expression. It is lib/settings.js now and is loaded like anything
 * else, along with everything read out of it.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const SettingsTable = Harness.requireXlet("./lib/settings.js");

function readFile(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("cannot read " + path);
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

function schemaKeys() {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    return Object.keys(schema).filter(key => schema[key].type !== "section").sort();
}

function tableEntries() {
    return SettingsTable.SETTINGS;
}

var cases = {};

cases["every setting in the schema is bound"] = function () {
    let bound = tableEntries().map(entry => entry.key);
    let unread = schemaKeys().filter(key => bound.indexOf(key) < 0);
    Harness.deepEqual(unread, [],
                      "the user can change these and the applet never reads them");
};

cases["every setting the applet binds is in the schema"] = function () {
    let keys = schemaKeys();
    let unknown = tableEntries().map(e => e.key).filter(key => keys.indexOf(key) < 0);
    Harness.deepEqual(unknown, [],
                      "these bind to nothing and leave their property undefined");
};

cases["no key is declared twice"] = function () {
    let seen = {};
    let twice = [];
    for (let entry of tableEntries()) {
        if (seen[entry.key])
            twice.push(entry.key);
        seen[entry.key] = true;
    }
    Harness.deepEqual(twice, [], "a second binding would overwrite the first");
};

cases["no property is used twice"] = function () {
    let seen = {};
    let clashes = [];
    for (let entry of tableEntries()) {
        if (seen[entry.property])
            clashes.push(entry.property + " for " + seen[entry.property] + " and " + entry.key);
        seen[entry.property] = entry.key;
    }
    Harness.deepEqual(clashes, [], "two settings writing to one property");
};

cases["a property name still matches its key"] = function () {
    /* Written out rather than transformed, but they should still agree, or
     * the next reader has to look the pair up every time. */
    let wrong = tableEntries()
        .filter(function (entry) {
            let expected = entry.key.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
            return entry.property !== expected;
        })
        .map(entry => entry.key + " is bound to " + entry.property);
    Harness.deepEqual(wrong, [], "surprising names");
};

cases["a setting that needs more than a repaint says so"] = function () {
    for (let key of ["refresh-interval", "temp-unit", "monitor-brightness",
                     "cycle-profile-hotkey", "toggle-menu-hotkey", "panel-icon-source"]) {
        let setting = tableEntries().find(entry => entry.key === key);
        Harness.ok(setting && SettingsTable.changeGroup(setting) !== "redraw",
                   key + " would only redraw, which is not enough for it");
    }
};

cases["a setting nobody bound is named"] = function () {
    let bound = {};
    for (let entry of tableEntries())
        bound[entry.property] = true;
    Harness.deepEqual(SettingsTable.unboundKeys(bound), [],
                      "everything in the table reads as bound when it is");
    delete bound.tempUnit;
    Harness.deepEqual(SettingsTable.unboundKeys(bound), ["temp-unit"],
                      "and the one that is not is the one reported");
};

cases["the temperature limit is carried across a change of unit"] = function () {
    let values = {
        tempUnit: "fahrenheit",
        highTempThreshold: 90,
        highTempThresholdFahrenheit: 194,
    };
    Harness.deepEqual(SettingsTable.temperatureLimitCarry("celsius", values),
                      { key: "high-temp-threshold-fahrenheit", value: 194 },
                      "90 C is written into the Fahrenheit key");
    values.tempUnit = "celsius";
    Harness.deepEqual(SettingsTable.temperatureLimitCarry("fahrenheit", values),
                      { key: "high-temp-threshold", value: 90 },
                      "and 194 F back into the Celsius one");
    Harness.equal(SettingsTable.temperatureLimitCarry("celsius", values), null,
                  "a unit that did not move carries nothing");
    Harness.equal(SettingsTable.temperatureLimitCarry(null, values), null,
                  "and neither does the first read, which moved from nothing");
};

cases["every comparison happens in Celsius"] = function () {
    Harness.equal(SettingsTable.highTempCelsius({
        tempUnit: "celsius", highTempThreshold: 90, highTempThresholdFahrenheit: 194,
    }), 90, "the Celsius setting is used directly");
    Harness.equal(SettingsTable.highTempCelsius({
        tempUnit: "fahrenheit", highTempThreshold: 90, highTempThresholdFahrenheit: 194,
    }), 90, "and the Fahrenheit one is converted");
};

cases["what the panel and the alerts are told comes from the settings"] = function () {
    let values = {
        panelText: "choose", panelShowBattery: true, panelShowPower: false,
        panelShowProfile: true, panelIconSource: "auto", tempUnit: "celsius",
        notifyLowBattery: true, notifyPeripheralBattery: false,
        lowBatteryThreshold: 20, peripheralBatteryThreshold: 15,
        criticalBatteryThreshold: 5, notifyHighTemp: true,
        highTempThreshold: 90, highTempThresholdFahrenheit: 194,
    };
    let panel = SettingsTable.panelOptions(values, "performance");
    Harness.equal(panel.showBattery, true, "the switch the list defers to is read");
    Harness.equal(panel.showPower, false, "and so is the one that is off");
    Harness.equal(panel.pendingProfile, "performance",
                  "a change the machine has not confirmed is not a setting");
    let limits = SettingsTable.alertLimits(values);
    Harness.equal(limits.criticalLevel, 5, "the critical level goes through");
    Harness.equal(limits.highTempCelsius, 90, "the temperature limit arrives in Celsius");
};

cases["the refresh interval distinguishes polled and signalled data"] = function () {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    let tooltip = schema["refresh-interval"].tooltip;
    Harness.ok(tooltip.indexOf("sensor readings") >= 0,
               "the timed sensor work is named");
    Harness.ok(tooltip.indexOf("UPower reports a change") >= 0,
               "battery updates are described as signal-driven");
    Harness.equal(tooltip.indexOf("battery levels are polled"), -1,
                  "the control no longer promises a battery hardware poll");
};

cases["the privileged setting names every gated control"] = function () {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    let setting = schema["enable-privileged-controls"];
    Harness.ok(setting.description.indexOf("privileged power settings") >= 0,
               "the switch is not described as CPU-only");
    Harness.ok(setting.tooltip.indexOf("ACPI platform profile") >= 0,
               "the firmware profile is named among the gated writes");
};

cases["disabling privileged writes keeps the charge limit readable"] = function () {
    let source = Harness.shellSource();
    let readStart = source.indexOf("    _readChargeLimit() {");
    let readEnd = source.indexOf("\n    }", readStart);
    let read = source.slice(readStart, readEnd);
    Harness.ok(read.indexOf("enablePrivilegedControls") < 0,
               "the read is not gated by write permission");

    let updateStart = source.indexOf("    _updateCharge(data, options) {");
    let updateEnd = source.indexOf("\n    }", updateStart);
    let update = source.slice(updateStart, updateEnd);
    Harness.ok(update.indexOf("let show = data.chargeLimitAvailable") >= 0,
               "availability controls visibility");
    Harness.ok(update.indexOf("let editable = options.privileged && !options.busy") >= 0,
               "permission controls only whether it can be changed");
};

cases["temperature thresholds require both the alert and their unit"] = function () {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    let keys = Object.keys(schema);
    let section = schema["high-temp-threshold-section"];
    Harness.equal(section.dependency, "notify-high-temp",
                  "the threshold section follows the notification switch");
    Harness.ok(keys.indexOf("high-temp-threshold-section") < keys.indexOf("high-temp-threshold"),
               "both threshold rows are inside that dependent section");
    Harness.equal(schema["high-temp-threshold"].dependency, "temp-unit=celsius",
                  "the Celsius row still follows its unit");
    Harness.equal(schema["high-temp-threshold-fahrenheit"].dependency, "temp-unit=fahrenheit",
                  "the Fahrenheit row still follows its unit");
};

cases["the primary sensor documentation names every primary kind"] = function () {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    let tooltip = schema["show-all-sensors"].tooltip;
    let readme = readFile(Harness.testsDir() + "/../README.md");
    for (let name of ["CPU", "GPU", "processor-package", "battery"])
        Harness.ok(tooltip.indexOf(name) >= 0, "the setting tooltip names " + name);
    Harness.ok(readme.indexOf("CPU, GPU, processor-package and battery sensors") >= 0,
               "the README names the complete primary set");
};

cases["external monitor documentation includes closed laptops"] = function () {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    let tooltip = schema["monitor-brightness"].tooltip;
    let readme = readFile(Harness.testsDir() + "/../README.md");
    Harness.ok(tooltip.indexOf("UPower reports the lid closed") >= 0,
               "the setting names the live topology exception");
    Harness.ok(readme.indexOf("while UPower reports its lid closed") >= 0,
               "the README promises the same closed-lid behavior");
};

/*
 * The schema on its own, and the two pairs of keys that are one setting.
 *
 * Everything above holds the schema against the applet's table. Nothing held
 * the schema against itself: a default outside its own range or off its own
 * list is a value the user never chose and cannot see chosen, and the two
 * pairs below are each a single quantity kept as two keys, where a drift in
 * one of them is only visible as the applet quietly rewriting a shipped
 * default or converting a limit into a number the other row cannot hold.
 */

function schema() {
    return JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
}

function celsiusFrom(fahrenheit) {
    return (fahrenheit - 32) * 5 / 9;
}

cases["every default is a value its own setting allows"] = function () {
    let all = schema();
    let wrong = [];
    for (let key in all) {
        let setting = all[key];
        if (setting.type === "section" || setting.default === undefined)
            continue;
        if (setting.type === "spinbutton") {
            if (typeof setting.min === "number" && setting.default < setting.min)
                wrong.push(key + " defaults to " + setting.default + ", below its own minimum " + setting.min);
            if (typeof setting.max === "number" && setting.default > setting.max)
                wrong.push(key + " defaults to " + setting.default + ", above its own maximum " + setting.max);
        }
        if (setting.type === "combobox") {
            let offered = Object.keys(setting.options || {}).map(label => setting.options[label]);
            if (offered.indexOf(setting.default) < 0)
                wrong.push(key + " defaults to " + JSON.stringify(setting.default) +
                           ", which is not one of " + JSON.stringify(offered));
        }
    }
    Harness.deepEqual(wrong, [], "a default nobody can choose is a value nobody chose");
};

cases["the shipped alert levels do not need correcting on first run"] = function () {
    let all = schema();
    /* lib/alerts.js keeps critical under low, and the applet writes the
     * correction into the settings the first time it runs. Shipped defaults
     * that need it would rewrite a user's settings file before they had ever
     * opened the window. */
    Harness.ok(all["critical-battery-threshold"].default < all["low-battery-threshold"].default,
               "the critical level is below the low one it has to fire before");
    Harness.ok(all["critical-battery-threshold"].min >= 1,
               "and no level is offered at zero, where nothing could fire");
};

cases["the two temperature keys describe one limit"] = function () {
    let all = schema();
    let celsius = all["high-temp-threshold"];
    let fahrenheit = all["high-temp-threshold-fahrenheit"];

    /* Switching the unit converts the value across, so the two rows have to
     * be the same limit and the same span. A default or a bound that drifts
     * shows up as a limit changing when only the unit was changed. */
    Harness.near(celsiusFrom(fahrenheit.default), celsius.default, 1,
                 "both defaults are the same temperature");
    Harness.near(celsiusFrom(fahrenheit.min), celsius.min, 1,
                 "and both rows start at the same temperature");
    Harness.near(celsiusFrom(fahrenheit.max), celsius.max, 1,
                 "and end at the same one, so a converted value always fits");
};
