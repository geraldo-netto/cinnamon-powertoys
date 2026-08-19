/*
 * cinnamon-powertoys - when to interrupt somebody, and how not to twice.
 *
 * Each poll hands over the reading and the limits in force; this decides
 * whether any of it is news. A device that has already been reported stays
 * quiet until it recovers, and recovering means climbing five points clear of
 * the limit, so one sitting exactly on it does not alternate.
 *
 * This was a class in applet.js, and its own comment said it took a notify "so
 * a run of readings can be pushed through it and the notifications counted".
 * That seam was written on purpose and could never be used: applet.js opens
 * with imports.ui.applet and cannot be loaded outside Cinnamon, so nothing
 * could construct it. Out here it is what it always claimed to be - a function
 * of a reading, a set of limits and what came before, with no widget, no
 * setting and no shell in it.
 *
 * Where a notification goes is the caller's business, which is why there is no
 * default worth having here: only the applet has a tray to put one in. It is
 * handed in, the same way lib/log.js is handed its sink.
 */

const Device = require("./lib/device.js");
const Format = require("./lib/format.js");
const Log = require("./lib/log.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * How far clear of its limit a device has to climb before it can be reported
 * again. Without it, a battery resting exactly on the threshold alternates
 * between reported and forgotten for as long as it sits there.
 */
const HYSTERESIS = 5;

/*
 * A device or sensor and what it just read, in a notification body.
 *
 * The same "label: value" join the rows and the tooltip use, so a translator
 * decides once what goes between the two. Format.readingName owns it.
 */
function readingText(source, reading) {
    return Format.readingName(source, reading);
}

/*
 * The critical level, kept under the low one.
 *
 * They are two spinbuttons on one axis with overlapping ranges - 1 to 30
 * against 5 to 50 - and nothing in the settings window stops critical being
 * set at or above low. Where it is, the low notification cannot happen at all:
 * a battery falling past both is tested against critical first, so the branch
 * for low is never taken, and a setting somebody changed on purpose silently
 * does nothing. That is the same failure _reportUnboundSettings exists to
 * catch, arrived at from the other end.
 *
 * Critical is the one that gives way. Low is what fires first on the way down
 * and is the number somebody sets to decide when they want warning; a critical
 * level at or above it was never a choice between the two, it was one of them
 * being moved without the other. Setting them equal leaves low reachable at
 * exactly its own value, which is what equal degrades to.
 */
function criticalBelow(critical, low) {
    if (typeof critical !== "number" || typeof low !== "number")
        return critical;
    return Math.max(1, Math.min(critical, low - 1));
}

const AlertPolicy = class AlertPolicy {
    /* `notify` is called as (urgent, title, body). */
    constructor(notify) {
        this._notify = notify || function () { return false; };
        this._alerted = new Map();
        this._tempAlerted = null;
        this._failures = new Log.FailureLog();
    }

    _deliver(urgent, title, body) {
        let key = urgent ? "urgent" : "normal";
        try {
            let delivered = this._notify(urgent, title, body) === true;
            if (delivered)
                this._failures.recover(key);
            return delivered;
        } catch (error) {
            this._failures.report(key, "alert delivery failed: " + error);
            return false;
        }
    }

    check(data, limits) {
        for (let device of data.devices)
            this._checkDevice(device, limits);
        this._forgetAbsent(data.devices, data);
        this._checkTemperature(data.selectedTemperature, limits);
    }

    /*
     * A device that has been reported is remembered so it is not reported
     * again, and it used to be remembered until it was seen back above its
     * limit. A headset switched off while low never got that far, so it kept
     * its entry for the session - and came back at the same level to silence.
     */
    _forgetAbsent(devices, readiness) {
        let present = new Set(devices.map(device => device.path));
        for (let path of Array.from(this._alerted.keys())) {
            if (present.has(path))
                continue;

            /* Absence is evidence only from the inventory that owns the path.
             * Preserve its latch while that source is degraded, but do not let
             * an unrelated source outage hide a confirmed disconnect. Unknown
             * paths are retained unless the complete combined inventory is
             * trustworthy. */
            let upowerPath = path.indexOf("/org/freedesktop/UPower/") === 0;
            let bluezPath = path.indexOf("/org/bluez/") === 0;
            if (upowerPath && readiness.upowerAvailable !== true)
                continue;
            if (bluezPath && readiness.bluezAvailable !== true)
                continue;
            if (!upowerPath && !bluezPath &&
                    (readiness.upowerAvailable !== true || readiness.bluezAvailable !== true))
                continue;
            this._alerted.delete(path);
        }
    }

    _checkDevice(device, limits) {
        let charge = Format.batteryReading(device);
        if (!charge.text)
            return;

        let system = device.powerSupply;
        let enabled = system ? limits.lowBattery : limits.peripheralBattery;
        let threshold = Device.lowThreshold(device, limits.lowLevel, limits.peripheralLevel);
        let level = this._alerted.get(device.path) || "";

        if (!enabled || !Device.isDraining(device)) {
            this._alerted.delete(device.path);
            return;
        }

        if (system && Device.chargeIsCritical(device, limits.criticalLevel)) {
            if (level !== "critical" &&
                this._deliver(true, _("Battery critically low"),
                              readingText(Format.deviceTitle(device), charge.text)))
                this._alerted.set(device.path, "critical");
            return;
        }
        if (Device.chargeIsLow(device, threshold)) {
            if (level === "" &&
                this._deliver(false, _("Battery low"),
                              readingText(Format.deviceTitle(device), charge.text)))
                this._alerted.set(device.path, "low");
            return;
        }
        if (Device.chargeRecovered(device, threshold, HYSTERESIS))
            this._alerted.delete(device.path);
    }

    _checkTemperature(sensor, limits) {
        if (!limits.highTemp) {
            this._tempAlerted = null;
            return;
        }
        /* No sample says nothing about recovery. Clearing here rearmed the
         * notification while the machine could still be above the threshold. */
        if (!sensor || sensor.celsius === null)
            return;
        let celsius = sensor.celsius;
        let identity = sensor.id || sensor.label || "temperature";
        if (celsius >= limits.highTempCelsius) {
            if (this._tempAlerted !== identity) {
                let source = sensor.label || sensor.groupLabel || _("Temperature");
                if (this._deliver(false, _("High temperature"),
                                  readingText(source,
                                      Format.temperature(celsius, limits.tempUnit, 1))))
                    this._tempAlerted = identity;
            }
        } else if (celsius < limits.highTempCelsius - HYSTERESIS) {
            this._tempAlerted = null;
        }
    }
};
