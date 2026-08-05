/*
 * cinnamon-powertoys - what a powered device is, in words.
 *
 * These were methods on the applet, for no better reason than that the
 * settings they read happened to live there. Every one of them is a function
 * of a device plus a couple of numbers: hand it those and it answers, with no
 * applet, no widgets and no shell involved.
 */

const UPowerGlib = imports.gi.UPowerGlib;

const Format = require("./lib/format.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceKind = UPowerGlib.DeviceKind;

function isSystemPowerDevice(device) {
    return device && device.powerSupply === true &&
           (device.kind === UPDeviceKind.BATTERY || device.kind === UPDeviceKind.UPS);
}

/*
 * Rows shared by the Devices group and alert policy. UPower's DisplayDevice
 * normally duplicates one or more physical batteries, so it stays out while
 * any physical system supply is known. During an incomplete enumeration it
 * is the only coherent system-battery snapshot left and must stand in for the
 * missing row instead of leaving the menu and policy blind.
 */
function withPrimary(devices, primary) {
    let rows = (devices || []).slice();
    if (!primary || rows.some(device => device.path === primary.path) ||
            rows.some(isSystemPowerDevice))
        return rows;
    rows.unshift(primary);
    return rows;
}

/*
 * Whether the device is spending its charge rather than taking it in.
 *
 * System batteries report a state that can be trusted. Peripherals very often
 * report none at all, so for those anything that is not explicitly on the
 * cable counts as draining - which is the safe way round: a mouse wrongly
 * called draining gets a warning it did not need, one wrongly called charging
 * goes flat in silence.
 */
function isDraining(device) {
    if (device.powerSupply)
        return device.state === UPDeviceState.DISCHARGING;
    return device.state !== UPDeviceState.CHARGING &&
           device.state !== UPDeviceState.FULLY_CHARGED &&
           device.state !== UPDeviceState.PENDING_CHARGE;
}

/*
 * The level at which this device counts as low. A mouse at 18% is not a
 * laptop at 18% - one wants a new pair of batteries this week, the other is
 * about to lose your work - so peripherals carry their own limit.
 */
function lowThreshold(device, systemLevel, peripheralLevel) {
    return device.powerSupply ? systemLevel : peripheralLevel;
}

/* Coarse LOW/CRITICAL readings are policy states, not percentages. */
function chargeIsLow(device, threshold) {
    let reading = Format.batteryReading(device);
    if (!reading.precise) {
        return reading.level === UPowerGlib.DeviceLevel.LOW ||
               reading.level === UPowerGlib.DeviceLevel.CRITICAL;
    }
    return reading.percentage <= threshold;
}

function chargeIsCritical(device, threshold) {
    let reading = Format.batteryReading(device);
    if (!reading.precise)
        return reading.level === UPowerGlib.DeviceLevel.CRITICAL;
    return reading.percentage <= threshold;
}

function chargeRecovered(device, threshold, hysteresis) {
    let reading = Format.batteryReading(device);
    if (!reading.precise) {
        return reading.level === UPowerGlib.DeviceLevel.NORMAL ||
               reading.level === UPowerGlib.DeviceLevel.HIGH ||
               reading.level === UPowerGlib.DeviceLevel.FULL;
    }
    return reading.percentage > threshold + hysteresis;
}

/* How long it has left, or how long until it is full. */
function remainingText(device) {
    if (device.state === UPDeviceState.DISCHARGING && device.timeToEmpty)
        return Format.duration(device.timeToEmpty) + " " + _("remaining");
    if (device.state === UPDeviceState.CHARGING && device.timeToFull)
        return Format.duration(device.timeToFull) + " " + _("until full");
    return "";
}

/*
 * The one line under a device's name: its status, stored charge and health,
 * in the order they matter. Live temperature and consumption belong to the
 * Sensors section, where UPower publishes them beside every other reading,
 * rather than being repeated here. Devices report wildly different subsets,
 * so each absent part is dropped rather than shown empty.
 */
function describe(device) {
    let parts = [];

    /* Peripherals usually report no state at all, and "Unknown" says less
     * than naming what the thing is. */
    if (device.state === UPDeviceState.UNKNOWN)
        parts.push(Format.deviceKindName(device.kind));
    else
        parts.push(Format.deviceStateName(device.state));

    parts.push(remainingText(device));
    if (device.voltage)
        parts.push(Format.volts(device.voltage));
    if (device.capacity && device.capacity < 100)
        parts.push(Translate.interpolate(_("health %{percent}"),
                                         { percent: Format.percent(device.capacity) }));
    if (device.cycles && device.cycles > 0)
        parts.push(device.cycles + " " + _("cycles"));
    if (device.energy && device.energyFull)
        parts.push(Format.energy(device.energy) + " / " + Format.energy(device.energyFull));

    return parts.filter(part => part !== "").join(" · ");
}

/*
 * What an empty Devices section means. UPower and BlueZ are both authorities
 * for rows, while the independent sysfs charge-limit discovery can prove a
 * battery is present even when neither can describe it. Never turn any
 * backend failure into an assertion that no battery exists.
 */
function emptyStatus(data) {
    if ((data.lines || []).length > 0 || (data.devices || []).length > 0)
        return "";
    if (data.chargeLimitAvailable)
        return _("A battery is present, but its status is unavailable");
    if (data.upowerAvailable !== true || data.bluezAvailable !== true)
        return _("Device status is unavailable");
    return _("Nothing with a battery is connected");
}

/*
 * The name at the top of a device's row: what it is, and how full.
 *
 * Devices that cannot measure a real percentage report a coarse level
 * instead, and saying "Low" is more honest than turning that into a number.
 */
function title(device) {
    let text = Format.deviceTitle(device);
    let charge = Format.batteryReading(device).text;
    return charge ? Translate.interpolate(
        _("%{device}  %{charge}"), { device: text, charge: charge }) : text;
}

/*
 * Which icon the row shows.
 *
 * A real battery keeps the one UPower chose, because that one encodes the
 * charge level. A peripheral gets an icon for what it is instead: UPower
 * hands out battery-missing for most of them, which says nothing useful about
 * a headset. St appends "-symbolic" itself, so UPower's name has to lose it.
 */
function iconName(device) {
    let name = device.powerSupply ? null : Format.deviceIconName(device.kind, null);
    if (!name && device.icon)
        name = device.icon.replace(/-symbolic$/, "");
    return name || Format.batteryIconName();
}

/*
 * Everything a row needs, worked out from a device and the settings in force.
 *
 * The row that displays this holds no rules at all - it sets three strings and
 * a style class - and none of what is decided here needs a widget to be
 * checked.
 */
function viewModel(device, options) {
    return {
        key: device.path,
        title: title(device),
        icon: iconName(device),
        details: describe(device),
        warning: isDraining(device) &&
                 chargeIsLow(device, lowThreshold(device, options.lowLevel,
                                                  options.peripheralLevel)),
    };
}
