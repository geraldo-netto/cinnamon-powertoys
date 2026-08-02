/*
 * cinnamon-powertoys - bluetooth device batteries, straight from BlueZ.
 *
 * UPower bridges these, but not always and not all of them: it needs to have
 * been built with the BlueZ backend, and even then a device has to be one it
 * recognises. Plenty of connected headsets, mice and controllers publish a
 * battery on org.bluez.Battery1 and never appear in UPower's device list.
 *
 * What comes out of here is the same shape UPower devices have, so the rest
 * of the applet cannot tell the difference, and anything BlueZ and UPower
 * both know about is dropped in favour of UPower's, which carries more.
 */

const Gio = imports.gi.Gio;
const UPowerGlib = imports.gi.UPowerGlib;

const Log = require("./lib/log.js");

var BUS_NAME = "org.bluez";

const UPDeviceKind = UPowerGlib.DeviceKind;
const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

/*
 * BlueZ says what a device is with a freedesktop icon name. They map onto
 * UPower's kinds, which is what the rest of the applet names and draws
 * devices by.
 */
const KINDS = {
    "audio-headset": UPDeviceKind.HEADSET,
    "audio-headphones": UPDeviceKind.HEADPHONES,
    "audio-card": UPDeviceKind.SPEAKERS,
    "input-mouse": UPDeviceKind.MOUSE,
    "input-keyboard": UPDeviceKind.KEYBOARD,
    "input-tablet": UPDeviceKind.TABLET,
    "input-gaming": UPDeviceKind.GAMING_INPUT,
    "phone": UPDeviceKind.PHONE,
    "computer": UPDeviceKind.COMPUTER,
    "camera-photo": UPDeviceKind.CAMERA,
    "printer": UPDeviceKind.PRINTER,
    "video-display": UPDeviceKind.MONITOR,
};

function _kind(icon) {
    return KINDS[icon] === undefined ? UPDeviceKind.BLUETOOTH_GENERIC : KINDS[icon];
}

/*
 * The part of a path that names the device itself. UPower calls a bluetooth
 * headset /org/freedesktop/UPower/devices/headset_dev_F4_4E_FD_01_53_0F and
 * BlueZ calls the same thing /org/bluez/hci0/dev_F4_4E_FD_01_53_0F, so this
 * is what tells us the two are one device.
 */
function addressOf(path) {
    let match = /dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})/.exec(path || "");
    return match ? match[1].toUpperCase() : null;
}

function _unpack(value) {
    return value && typeof value.deepUnpack === "function" ? value.deepUnpack() : value;
}

/*
 * Turns one entry of BlueZ's object tree into a device, or null when it is
 * not one we can say anything about: not connected, or no battery.
 */
function describe(path, interfaces) {
    let device = interfaces["org.bluez.Device1"];
    let battery = interfaces["org.bluez.Battery1"];
    if (!device || !battery)
        return null;
    if (_unpack(device.Connected) !== true)
        return null;

    let percentage = _unpack(battery.Percentage);
    if (typeof percentage !== "number")
        return null;

    return {
        path: path,
        address: addressOf(path),
        kind: _kind(_unpack(device.Icon)),
        /* BlueZ says nothing about charging, and a device that is charging is
         * usually on a cable and off bluetooth anyway. */
        state: UPDeviceState.UNKNOWN,
        vendor: "",
        model: _unpack(device.Alias) || _unpack(device.Name) || "",
        icon: "",
        powerSupply: false,
        online: true,
        present: true,
        percentage: percentage,
        energy: null,
        energyFull: null,
        energyRate: null,
        voltage: null,
        temperature: null,
        capacity: null,
        cycles: null,
        timeToEmpty: null,
        timeToFull: null,
        batteryLevel: UPDeviceLevel.NONE,
    };
}

function parseObjects(objects) {
    let devices = [];
    for (let path in objects) {
        let device = describe(path, objects[path]);
        if (device)
            devices.push(device);
    }
    devices.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    return devices;
}

/*
 * Watches BlueZ for connected devices that report a battery.
 *
 * The object tree is asked for once and then kept in step by the signals
 * BlueZ emits as devices come, go and change, so a poll costs nothing.
 */
var BluezBatteries = class BluezBatteries {
    constructor(onChanged, call) {
        this.available = false;
        this.destroyed = false;
        this.devices = [];

        this._onChanged = onChanged || function () {};
        this._call = call || ((path, iface, method, onDone) => this._dbusCall(path, iface, method, onDone));
        this._signalIds = [];

        this._refresh();
        this._watch();
    }

    _dbusCall(path, iface, method, onDone) {
        Gio.DBus.system.call(BUS_NAME, path, iface, method, null, null,
                             Gio.DBusCallFlags.NONE, -1, null,
                             (connection, result) => {
                                 try {
                                     onDone(connection.call_finish(result).deepUnpack()[0]);
                                 } catch (error) {
                                     /* bluetoothd is not running, which is
                                      * ordinary on a desktop without a radio. */
                                     onDone(null);
                                 }
                             });
    }

    _refresh() {
        this._call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", objects => {
            if (this.destroyed)
                return;
            if (!objects) {
                this.available = false;
                this.devices = [];
                return;
            }
            this.available = true;
            let devices = parseObjects(objects);
            let changed = devices.length !== this.devices.length ||
                          devices.some((device, i) => device.path !== this.devices[i].path ||
                                                      device.percentage !== this.devices[i].percentage);
            this.devices = devices;
            if (changed)
                this._onChanged();
        });
    }

    /* Anything at all moving in BlueZ's tree is cheap to react to, because
     * reacting means one D-Bus call that BlueZ answers out of memory. */
    _watch() {
        for (let signal of ["InterfacesAdded", "InterfacesRemoved"]) {
            try {
                this._signalIds.push(Gio.DBus.system.signal_subscribe(
                    BUS_NAME, "org.freedesktop.DBus.ObjectManager", signal, null, null,
                    Gio.DBusSignalFlags.NONE, () => this._refresh()));
            } catch (error) {
                Log.error("cannot watch BlueZ for " + signal + ": " + error);
            }
        }
        try {
            this._signalIds.push(Gio.DBus.system.signal_subscribe(
                BUS_NAME, "org.freedesktop.DBus.Properties", "PropertiesChanged", null, null,
                Gio.DBusSignalFlags.NONE, () => this._refresh()));
        } catch (error) {
            Log.error("cannot watch BlueZ for property changes: " + error);
        }
    }

    /*
     * The devices BlueZ knows about that the given list does not already
     * cover. UPower's entry for a device is the better one where it exists -
     * it has the state and often the model - so this only fills gaps.
     */
    missingFrom(known) {
        let seen = {};
        for (let device of known) {
            let address = addressOf(device.path);
            if (address)
                seen[address] = true;
        }
        return this.devices.filter(device => !device.address || !seen[device.address]);
    }

    destroy() {
        this.destroyed = true;
        for (let id of this._signalIds) {
            try {
                Gio.DBus.system.signal_unsubscribe(id);
            } catch (error) {
                /* already gone */
            }
        }
        this._signalIds = [];
        this.devices = [];
        this.available = false;
    }
};
