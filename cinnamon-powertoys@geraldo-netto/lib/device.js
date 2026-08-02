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

/* How long it has left, or how long until it is full. */
function remainingText(device) {
    if (device.state === UPDeviceState.DISCHARGING && device.timeToEmpty)
        return Format.duration(device.timeToEmpty) + " " + _("remaining");
    if (device.state === UPDeviceState.CHARGING && device.timeToFull)
        return Format.duration(device.timeToFull) + " " + _("until full");
    return "";
}

/*
 * The one line under a device's name: everything it is willing to say about
 * itself, in the order it matters. Devices report wildly different subsets -
 * a laptop battery has all of it, a bluetooth mouse has a percentage and
 * nothing else - so each part is dropped rather than shown empty.
 */
function describe(device, tempUnit) {
    let parts = [];

    /* Peripherals usually report no state at all, and "Unknown" says less
     * than naming what the thing is. */
    if (device.state === UPDeviceState.UNKNOWN)
        parts.push(Format.deviceKindName(device.kind));
    else
        parts.push(Format.deviceStateName(device.state));

    parts.push(remainingText(device));
    if (device.energyRate)
        parts.push(Format.watts(device.energyRate));
    if (device.voltage)
        parts.push(Format.volts(device.voltage));
    if (device.temperature)
        parts.push(Format.temperature(device.temperature, tempUnit, 1));
    if (device.capacity && device.capacity < 100)
        parts.push(_("health") + " " + Format.percent(device.capacity));
    if (device.cycles && device.cycles > 0)
        parts.push(device.cycles + " " + _("cycles"));
    if (device.energy && device.energyFull)
        parts.push(Format.energy(device.energy) + " / " + Format.energy(device.energyFull));

    return parts.filter(part => part !== "").join(" · ");
}
