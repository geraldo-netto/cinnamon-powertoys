/*
 * cinnamon-powertoys - UPower client.
 *
 * Talks to org.freedesktop.UPower directly rather than through csd-power,
 * because the settings daemon only forwards a fixed tuple and drops the
 * interesting fields (energy rate, voltage, temperature, capacity, cycles).
 */

const Gio = imports.gi.Gio;
const UPowerGlib = imports.gi.UPowerGlib;

const Format = require("./lib/format.js");
const Log = require("./lib/log.js");

var BUS_NAME = "org.freedesktop.UPower";
var MANAGER_PATH = "/org/freedesktop/UPower";
var DISPLAY_DEVICE_PATH = "/org/freedesktop/UPower/devices/DisplayDevice";

const MANAGER_XML = '<node>\
<interface name="org.freedesktop.UPower">\
    <method name="EnumerateDevices">\
        <arg type="ao" direction="out" name="devices"/>\
    </method>\
    <method name="GetDisplayDevice">\
        <arg type="o" direction="out" name="device"/>\
    </method>\
    <signal name="DeviceAdded"><arg type="o" name="device"/></signal>\
    <signal name="DeviceRemoved"><arg type="o" name="device"/></signal>\
    <property name="OnBattery" type="b" access="read"/>\
</interface>\
</node>';

const DEVICE_XML = '<node>\
<interface name="org.freedesktop.UPower.Device">\
    <property name="Vendor" type="s" access="read"/>\
    <property name="Model" type="s" access="read"/>\
    <property name="Type" type="u" access="read"/>\
    <property name="PowerSupply" type="b" access="read"/>\
    <property name="Online" type="b" access="read"/>\
    <property name="Energy" type="d" access="read"/>\
    <property name="EnergyFull" type="d" access="read"/>\
    <property name="EnergyRate" type="d" access="read"/>\
    <property name="Voltage" type="d" access="read"/>\
    <property name="ChargeCycles" type="i" access="read"/>\
    <property name="Temperature" type="d" access="read"/>\
    <property name="TimeToEmpty" type="x" access="read"/>\
    <property name="TimeToFull" type="x" access="read"/>\
    <property name="Percentage" type="d" access="read"/>\
    <property name="IsPresent" type="b" access="read"/>\
    <property name="State" type="u" access="read"/>\
    <property name="Capacity" type="d" access="read"/>\
    <property name="BatteryLevel" type="u" access="read"/>\
    <property name="IconName" type="s" access="read"/>\
</interface>\
</node>';

const ManagerProxy = Gio.DBusProxy.makeProxyWrapper(MANAGER_XML);
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DEVICE_XML);

const UPDeviceKind = UPowerGlib.DeviceKind;
const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

function _number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/*
 * What the batteries contribute to the sensor lists.
 *
 * A battery is a sensor as much as a hwmon chip is: it reports its own
 * temperature, and the rate it is charging or draining at is a power meter.
 * So its readings carry everything a hwmon reading carries, including the
 * grouping - one group per device, headed by the device's own name, with the
 * rows under it saying only what they measure. That is the same shape
 * lib/sensors.js produces, and it has to be: the menu concatenates the two
 * lists and groups the result without knowing which came from where.
 *
 * A plain function of a device list, so the shape can be checked without a
 * system bus.
 */
function sensorReadings(devices) {
    let temperatures = [];
    let powers = [];

    for (let device of devices) {
        let title = Format.deviceTitle(device);
        let group = "upower:" + device.path;

        /*
         * Zero degrees is dropped, and it is a reading.
         *
         * It has to be, because UPower cannot say the other thing. Temperature
         * is a plain `d` on the interface with no "is present" beside it, and
         * a device with no thermometer in it publishes 0.0 rather than
         * declining to answer - a bluetooth headset does exactly that. Letting
         * 0 through put "Temperature 0.0 °C" under a heading with the
         * headset's name on it, on a machine where nothing was measuring
         * anything. A battery that really is at freezing loses its row; a
         * dozen devices that measure nothing would otherwise gain one.
         */
        if (device.temperature)
            temperatures.push({
                id: "upower:" + device.path,
                measure: "temperature",
                chip: title,
                kind: "battery",
                label: title,
                group: group,
                groupLabel: title,
                shortLabel: Format.measureName("temperature"),
                critical: null,
                celsius: device.temperature,
            });

        /* Zero watts is not: a battery at rest reports it, and a row saying
         * the machine is drawing nothing at all is worse than no row. */
        if (device.powerSupply && device.energyRate)
            powers.push({
                id: "upower:" + device.path,
                measure: "power",
                kind: "battery",
                label: title,
                group: group,
                groupLabel: title,
                shortLabel: Format.measureName("power"),
                watts: device.energyRate,
            });
    }

    return { temperatures: temperatures, powers: powers };
}

/*
 * The devices worth a row, in the order they are shown.
 *
 * A plain function of described devices, so what gets dropped can be checked
 * without a system bus - which is how the two guards this replaces went so long
 * without anyone noticing that neither could fire. Both asked whether the
 * percentage was null, and on a live bus it never is: Percentage is a plain `d`
 * with no "is present" beside it, so a battery that is not fitted publishes 0.0
 * exactly as a flat one does. This file already knew that trap - it is the
 * whole of the comment over the temperature in sensorReadings - and the guards
 * walked into it from the other side.
 *
 * IsPresent is the field they meant to ask, so a device that says it is not
 * there is dropped whatever else it says. A laptop with its battery out listed
 * one at 0%, and where UPower composes no display device _primaryDevice took
 * that absent battery as the machine's own, so the panel read 0% too. It covers
 * what the second guard was for as well: a proxy carrying no properties at all
 * answers false here.
 *
 * Line power adapters are not dropped so much as reported elsewhere, through
 * lineDevices(), because whether the cable is in is a different question from
 * what is carrying a charge.
 */
function reportedDevices(devices) {
    return devices
        .filter(device => device.kind !== UPDeviceKind.LINE_POWER && device.present)
        .sort((a, b) => {
            if (a.powerSupply !== b.powerSupply)
                return a.powerSupply ? -1 : 1;
            if (a.kind !== b.kind)
                return a.kind - b.kind;
            return a.path < b.path ? -1 : 1;
        });
}

var UPowerMonitor = class UPowerMonitor {
    /*
     * onChanged is called whenever the device set or any device property
     * changes; onReady once the initial enumeration is complete.
     */
    constructor(onChanged, onReady) {
        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._devices = new Map();
        this._deviceSignals = new Map();
        this._manager = null;
        this._display = null;
        this._busSignalIds = [];
        this._propSignalId = 0;
        this.available = false;
        this.destroyed = false;

        try {
            new ManagerProxy(Gio.DBus.system, BUS_NAME, MANAGER_PATH,
                             (proxy, error) => this._onManagerReady(proxy, error));
        } catch (e) {
            Log.error("cannot reach UPower: " + e);
        }
    }

    _onManagerReady(proxy, error) {
        if (this.destroyed)
            return;
        if (error || !proxy) {
            Log.error("UPower manager unavailable: " + (error ? error.message : "no proxy"));
            this._onReady();
            return;
        }

        this._manager = proxy;
        this.available = true;

        this._busSignalIds.push(proxy.connectSignal("DeviceAdded", (p, sender, [path]) => {
            this._addDevice(path);
        }));
        this._busSignalIds.push(proxy.connectSignal("DeviceRemoved", (p, sender, [path]) => {
            this._removeDevice(path);
            this._onChanged();
        }));
        this._propSignalId = proxy.connect("g-properties-changed", () => this._onChanged());

        new DeviceProxy(Gio.DBus.system, BUS_NAME, DISPLAY_DEVICE_PATH, (displayProxy, displayError) => {
            if (!this.destroyed && !displayError)
                this._display = displayProxy;
        });

        proxy.EnumerateDevicesRemote((result, enumError) => {
            if (this.destroyed)
                return;
            if (enumError) {
                Log.error("EnumerateDevices failed: " + enumError.message);
                this._onReady();
                return;
            }
            let paths = result[0] || [];
            let pending = paths.length;
            if (pending === 0) {
                this._onReady();
                this._onChanged();
                return;
            }
            for (let path of paths)
                this._addDevice(path, () => {
                    if (--pending === 0) {
                        this._onReady();
                        this._onChanged();
                    }
                });
        });
    }

    _addDevice(path, done) {
        if (this._devices.has(path)) {
            if (done)
                done();
            return;
        }
        new DeviceProxy(Gio.DBus.system, BUS_NAME, path, (proxy, error) => {
            if (this.destroyed) {
                if (done)
                    done();
                return;
            }
            if (error || !proxy) {
                if (done)
                    done();
                return;
            }
            let signalId = proxy.connect("g-properties-changed", () => this._onChanged());
            this._devices.set(path, proxy);
            this._deviceSignals.set(path, signalId);
            if (done)
                done();
            else
                this._onChanged();
        });
    }

    /* Devices come and go all the time (bluetooth, docks, USB), so the
     * property handler has to go with them or it accumulates for the life of
     * the session. */
    _removeDevice(path) {
        let proxy = this._devices.get(path);
        let signalId = this._deviceSignals.get(path);
        if (proxy && signalId) {
            try {
                proxy.disconnect(signalId);
            } catch (e) {
                /* the proxy is already gone */
            }
        }
        this._devices.delete(path);
        this._deviceSignals.delete(path);
    }

    get onBattery() {
        return this._manager ? this._manager.OnBattery === true : false;
    }

    _describe(proxy, path) {
        let kind = proxy.Type === undefined ? UPDeviceKind.UNKNOWN : proxy.Type;
        return {
            path: path,
            kind: kind,
            state: proxy.State === undefined ? UPDeviceState.UNKNOWN : proxy.State,
            vendor: proxy.Vendor || "",
            model: proxy.Model || "",
            icon: proxy.IconName || "",
            powerSupply: proxy.PowerSupply === true,
            online: proxy.Online === true,
            present: proxy.IsPresent === true,
            percentage: _number(proxy.Percentage),
            energy: _number(proxy.Energy),
            energyFull: _number(proxy.EnergyFull),
            energyRate: _number(proxy.EnergyRate),
            voltage: _number(proxy.Voltage),
            temperature: _number(proxy.Temperature),
            capacity: _number(proxy.Capacity),
            cycles: _number(proxy.ChargeCycles),
            timeToEmpty: _number(proxy.TimeToEmpty),
            timeToFull: _number(proxy.TimeToFull),
            batteryLevel: proxy.BatteryLevel === undefined ? UPDeviceLevel.NONE : proxy.BatteryLevel,
        };
    }

    /*
     * Every device that carries a charge, batteries first, then peripherals.
     * Which those are, and what order they come in, is reportedDevices - a
     * function of the descriptions, and so something that can be held to
     * without a bus.
     */
    snapshot() {
        let devices = [];
        for (let [path, proxy] of this._devices)
            devices.push(this._describe(proxy, path));
        return reportedDevices(devices);
    }

    lineDevices() {
        let devices = [];
        for (let [path, proxy] of this._devices) {
            if (proxy.Type === UPDeviceKind.LINE_POWER)
                devices.push(this._describe(proxy, path));
        }
        return devices;
    }

    /* The composite battery UPower builds for the panel, when there is one. */
    displayDevice() {
        if (!this._display || this._display.Type !== UPDeviceKind.BATTERY)
            return null;
        if (this._display.IsPresent !== true)
            return null;
        return this._describe(this._display, DISPLAY_DEVICE_PATH);
    }

    /*
     * The device the panel speaks for. UPower composes one out of whatever
     * batteries are fitted, but not on every machine and not always before
     * the first poll, so the first system battery or UPS stands in.
     */
    _primaryDevice(devices) {
        let display = this.displayDevice();
        if (display)
            return display;
        for (let device of devices) {
            if (device.powerSupply &&
                (device.kind === UPDeviceKind.BATTERY || device.kind === UPDeviceKind.UPS))
                return device;
        }
        return null;
    }

    /* Everything the applet takes from UPower, as of now. */
    read() {
        let devices = this.snapshot();
        let lines = this.lineDevices();
        let readings = sensorReadings(devices);
        return {
            available: this.available,
            devices: devices,
            lines: lines,
            primary: this._primaryDevice(devices),
            onBattery: this.onBattery,
            lineOnline: lines.some(device => device.online),
            temperatures: readings.temperatures,
            powers: readings.powers,
        };
    }

    destroy() {
        this.destroyed = true;
        if (this._manager) {
            for (let id of this._busSignalIds) {
                try {
                    this._manager.disconnectSignal(id);
                } catch (e) {
                    /* already gone */
                }
            }
            if (this._propSignalId) {
                try {
                    this._manager.disconnect(this._propSignalId);
                } catch (e) {
                    /* already gone */
                }
            }
        }
        this._busSignalIds = [];
        this._propSignalId = 0;

        for (let path of Array.from(this._devices.keys()))
            this._removeDevice(path);

        this._manager = null;
        this._display = null;
    }
};
