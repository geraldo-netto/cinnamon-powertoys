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
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * How far clear of its limit a device has to climb before it can be reported
 * again. Without it, a battery resting exactly on the threshold alternates
 * between reported and forgotten for as long as it sits there.
 */
var HYSTERESIS = 5;

var AlertPolicy = class AlertPolicy {
    /* `notify` is called as (urgent, title, body). */
    constructor(notify) {
        this._notify = notify || function () {};
        this._alerted = new Map();
        this._tempAlerted = false;
    }

    check(data, limits) {
        for (let device of data.devices)
            this._checkDevice(device, limits);
        this._forgetAbsent(data.devices);
        this._checkTemperature(data.cpuTemperature, limits);
    }

    /*
     * A device that has been reported is remembered so it is not reported
     * again, and it used to be remembered until it was seen back above its
     * limit. A headset switched off while low never got that far, so it kept
     * its entry for the session - and came back at the same level to silence.
     */
    _forgetAbsent(devices) {
        let present = new Set(devices.map(device => device.path));
        for (let path of Array.from(this._alerted.keys())) {
            if (!present.has(path))
                this._alerted.delete(path);
        }
    }

    _checkDevice(device, limits) {
        if (device.percentage === null)
            return;

        let system = device.powerSupply;
        let enabled = system ? limits.lowBattery : limits.peripheralBattery;
        let threshold = Device.lowThreshold(device, limits.lowLevel, limits.peripheralLevel);
        let level = this._alerted.get(device.path) || "";

        if (!enabled || !Device.isDraining(device)) {
            this._alerted.delete(device.path);
            return;
        }

        if (system && device.percentage <= limits.criticalLevel) {
            if (level !== "critical") {
                this._alerted.set(device.path, "critical");
                this._notify(true, _("Battery critically low"),
                             Format.deviceTitle(device) + " - " +
                             Format.percent(device.percentage));
            }
        } else if (device.percentage <= threshold) {
            if (level === "") {
                this._alerted.set(device.path, "low");
                this._notify(false, _("Battery low"),
                             Format.deviceTitle(device) + " - " +
                             Format.percent(device.percentage));
            }
        } else if (device.percentage > threshold + HYSTERESIS) {
            this._alerted.delete(device.path);
        }
    }

    _checkTemperature(celsius, limits) {
        if (!limits.highTemp || celsius === null) {
            this._tempAlerted = false;
            return;
        }
        if (celsius >= limits.highTempCelsius) {
            if (!this._tempAlerted) {
                this._tempAlerted = true;
                this._notify(false, _("High temperature"),
                             Format.temperature(celsius, limits.tempUnit, 1));
            }
        } else if (celsius < limits.highTempCelsius - HYSTERESIS) {
            this._tempAlerted = false;
        }
    }
};
