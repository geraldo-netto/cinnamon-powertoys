/*
 * Every setting this applet binds, and everything read out of them.
 *
 * The table and the five readers that turn it into something usable lived in
 * applet.js, which imports the shell at its first line and so cannot be loaded
 * outside Cinnamon. That put the whole of "what the settings mean" behind a
 * session: the table could only be checked against the schema by reading
 * applet.js as text with a regular expression, and the temperature limit
 * carried from one unit to the other - arithmetic, with a rounding, that is
 * wrong in both directions if it is wrong - had no case at all.
 *
 * Everything here is a function of values that were handed in. Binding those
 * values to the shell's settings object stays in applet.js, because that is the
 * one part of it that is the shell's.
 */

const PanelText = require("./lib/panel-text.js");

/*
 * Every setting this applet binds, and what has to happen when it moves.
 *
 * The property names used to be produced from the keys by a string transform,
 * so a key that was not in the schema bound to nothing and left an undefined
 * property, which reads as "off" everywhere it is used - a switch that cannot
 * be turned on, and no error to say why. Written out, the pair is checked
 * once at bind time and a mismatch is reported instead of silently obeyed.
 *
 * Most of these only need the applet to draw itself again. The ones that do
 * not say so, so that changing the temperature unit does not fold a submenu
 * and picking a panel icon does not re-register the hotkeys.
 */
const SETTINGS = [
    { key: "refresh-interval", property: "refreshInterval", onChange: "poll" },
    { key: "temp-unit", property: "tempUnit", onChange: "unit" },
    { key: "cpu-sensor-hint", property: "cpuSensorHint" },

    { key: "panel-icon-source", property: "panelIconSource", onChange: "icon" },
    { key: "panel-text", property: "panelText" },
    { key: "panel-show-battery", property: "panelShowBattery" },
    { key: "panel-show-power", property: "panelShowPower" },
    { key: "panel-show-profile", property: "panelShowProfile" },
    /* Not shown anywhere: whether the three above have been read once into
     * the list that replaced them. */
    { key: "panel-text-migrated", property: "panelTextMigrated" },

    { key: "show-profiles", property: "showProfiles" },
    { key: "show-cpu", property: "showCpu" },
    { key: "show-devices", property: "showDevices" },
    { key: "show-sensors", property: "showSensors" },
    { key: "show-all-sensors", property: "showAllSensors" },
    { key: "monitor-brightness", property: "monitorBrightness", onChange: "monitor" },

    /* Not shown anywhere: whether this install has introduced itself yet. */
    { key: "introduced", property: "introduced" },

    { key: "enable-privileged-controls", property: "enablePrivilegedControls" },
    { key: "scroll-action", property: "scrollAction" },
    { key: "middle-click-action", property: "middleClickAction" },
    { key: "cycle-profile-hotkey", property: "cycleProfileHotkey", onChange: "hotkeys" },
    { key: "toggle-menu-hotkey", property: "toggleMenuHotkey", onChange: "hotkeys" },

    { key: "notify-low-battery", property: "notifyLowBattery" },
    { key: "low-battery-threshold", property: "lowBatteryThreshold", onChange: "alertLevels" },
    { key: "critical-battery-threshold", property: "criticalBatteryThreshold", onChange: "alertLevels" },
    { key: "notify-peripheral-battery", property: "notifyPeripheralBattery" },
    { key: "peripheral-battery-threshold", property: "peripheralBatteryThreshold" },
    { key: "notify-high-temp", property: "notifyHighTemp" },
    { key: "high-temp-threshold", property: "highTempThreshold" },
    { key: "high-temp-threshold-fahrenheit", property: "highTempThresholdFahrenheit" },
];

/* Which key each handler name belongs to, for a caller binding the table. */
function changeGroup(setting) {
    return (setting && setting.onChange) || "redraw";
}

/*
 * The keys that bound to nothing.
 *
 * A key that is not in the schema binds without complaint and leaves its
 * property undefined, and undefined reads as "off" at every one of the places
 * that use it. Saying so once, at startup, is the difference between a five
 * minute fix and a puzzling bug report.
 */
function unboundKeys(values) {
    return SETTINGS
        .filter(setting => !values || values[setting.property] === undefined)
        .map(setting => setting.key);
}

/* What the three switches say, which is only read where the list is on
 * "Choose below" - and once, on the way past them. */
function panelSwitches(values) {
    return {
        battery: values.panelShowBattery,
        power: values.panelShowPower,
        profile: values.panelShowProfile,
    };
}

/* Sensors are read in Celsius, so every comparison happens there. */
function highTempCelsius(values) {
    if (values.tempUnit === "fahrenheit")
        return (values.highTempThresholdFahrenheit - 32) * 5 / 9;
    return values.highTempThreshold;
}

/*
 * The high temperature limit, carried across a change of unit.
 *
 * It is kept as two settings, one per unit, so it is always typed in the unit
 * the rest of the applet is showing; only the one matching the current unit is
 * revealed by the settings window. They are two views of a single limit, so
 * switching the unit carries the value across rather than leaving a stale
 * number in the other key.
 *
 * Answers the setting to write and what to write to it, or null when there is
 * nothing to carry: the unit did not move, or this is the first read and there
 * is no previous unit to have moved from.
 */
function temperatureLimitCarry(previousUnit, values) {
    if (!previousUnit || previousUnit === values.tempUnit)
        return null;
    if (values.tempUnit === "fahrenheit")
        return {
            key: "high-temp-threshold-fahrenheit",
            value: Math.round(values.highTempThreshold * 9 / 5 + 32),
        };
    return {
        key: "high-temp-threshold",
        value: Math.round((values.highTempThresholdFahrenheit - 32) * 5 / 9),
    };
}

/* What the panel presenter is told, from the settings and one thing that is
 * not a setting: a change the machine has not confirmed yet. */
function panelOptions(values, pendingProfile) {
    let text = PanelText.panelParts(values.panelText, panelSwitches(values));
    return {
        showBattery: text.battery,
        showPower: text.power,
        showProfile: text.profile,
        iconSource: values.panelIconSource,
        tempUnit: values.tempUnit,
        /* see Reading.shownProfile */
        pendingProfile: pendingProfile,
    };
}

/* What the alert policy is told. */
function alertLimits(values) {
    return {
        lowBattery: values.notifyLowBattery,
        peripheralBattery: values.notifyPeripheralBattery,
        lowLevel: values.lowBatteryThreshold,
        peripheralLevel: values.peripheralBatteryThreshold,
        criticalLevel: values.criticalBatteryThreshold,
        highTemp: values.notifyHighTemp,
        highTempCelsius: highTempCelsius(values),
        tempUnit: values.tempUnit,
    };
}
