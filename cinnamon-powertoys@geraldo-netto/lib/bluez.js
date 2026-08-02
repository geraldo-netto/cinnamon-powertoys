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
const GLib = imports.gi.GLib;
const UPowerGlib = imports.gi.UPowerGlib;

const Log = require("./lib/log.js");

var BUS_NAME = "org.bluez";

/*
 * The interfaces this module reads, and so the only ones worth waking for.
 *
 * PropertiesChanged carries the interface as its first argument, which means
 * the bus can do the filtering. Without it every property BlueZ publishes came
 * through: a media transport's volume for each notch of a headset's own
 * buttons, an adapter's discovery state, a characteristic's value. None of
 * those can move a battery percentage, and each one cost a round trip.
 */
const WATCHED_INTERFACES = ["org.bluez.Device1", "org.bluez.Battery1"];

/*
 * How long a burst of BlueZ signals is allowed to settle before the tree is
 * read again.
 *
 * The filter above drops what is not this module's business; this is for what
 * is. Device1 carries RSSI, which BlueZ republishes several times a second per
 * device while an adapter is discovering, and every one of those was a
 * GetManagedObjects of its own. Long enough to gather a burst into one read,
 * short enough that nobody watching the menu sees the wait.
 */
var REFRESH_SETTLE_MS = 250;

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

/*
 * Whether two readings of one device would draw the same row.
 *
 * The path and the percentage were the whole of this, and a row is more than
 * those two: its title is the model and its icon is chosen from the kind. Both
 * of those come off org.bluez.Device1, which is watched precisely so that the
 * list follows the device - so a headset renamed in the bluetooth settings, or
 * one whose Icon BlueZ works out a moment after it connects, reached
 * this.devices and was reported to nobody, and the menu kept the old row until
 * something else happened to redraw it.
 *
 * What is compared is what is displayed, which is the rule that keeps this
 * honest as the row grows.
 */
function _sameRow(a, b) {
    return a.path === b.path && a.percentage === b.percentage &&
           a.model === b.model && a.kind === b.kind;
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
        this._refreshTimerId = 0;
        /* A read of the tree is in flight, and one was asked for while it
         * was; see _refresh. */
        this._reading = false;
        this._readAgain = false;

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

    /*
     * One read of the tree at a time, and the one asked for meanwhile is taken
     * once that has answered.
     *
     * The settle timer stops a burst of signals arming twice, and does nothing
     * about a burst that spans two of them: the timer fires, the call goes
     * out, and the next burst can arm and fire again before it answers. Two
     * GetManagedObjects then settle in whatever order they come back in, and
     * the older one can be the one that wins. Cheaper to skip the read than to
     * work out which answer is the newer.
     *
     * Skipping it is right; forgetting it was not. The timer that asked has
     * already fired and cleared itself, so nothing re-arms, and whatever was
     * behind that signal - a headset switched off, a mouse connecting - waited
     * for the next unrelated signal to carry it in. On a quiet desk that is
     * whenever. One flag, taken when the read in flight has settled, which is
     * the same shape the applet's own _update uses for the same problem.
     */
    _refresh() {
        if (this._reading) {
            this._readAgain = true;
            return;
        }
        this._reading = true;
        this._call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", objects => {
            this._reading = false;
            if (this.destroyed)
                return;
            this.available = !!objects;
            this._settle(objects ? parseObjects(objects) : []);
            if (this._readAgain) {
                this._readAgain = false;
                this._refresh();
            }
        });
    }

    /*
     * Takes the list, and reports it where it is not the list that was there.
     *
     * Both answers come through here, which is the point. The empty one used
     * to return early without a word: bluetoothd going away, or answering
     * nothing, cleared the devices and told nobody, so the menu kept rows for
     * things that were no longer connected until the next poll swept them - up
     * to a whole refresh interval, on a list whose entire job is to say what is
     * connected now. Clearing a list that had something in it is exactly the
     * kind of change the callback exists for.
     */
    _settle(devices) {
        let changed = devices.length !== this.devices.length ||
                      devices.some((device, i) => !_sameRow(device, this.devices[i]));
        this.devices = devices;
        if (changed)
            this._onChanged();
    }

    /*
     * A device coming or going, and a property changing on one of the two
     * interfaces this module parses.
     *
     * Reacting means one D-Bus call that BlueZ answers out of memory, which is
     * cheap - but it was subscribed to every property BlueZ publishes and
     * taken on every one of them, which is not the same thing. See
     * WATCHED_INTERFACES and REFRESH_SETTLE_MS.
     */
    _watch() {
        for (let signal of ["InterfacesAdded", "InterfacesRemoved"])
            this._subscribe("org.freedesktop.DBus.ObjectManager", signal, null);
        for (let iface of WATCHED_INTERFACES)
            this._subscribe("org.freedesktop.DBus.Properties", "PropertiesChanged", iface);
    }

    _subscribe(iface, member, arg0) {
        try {
            this._signalIds.push(Gio.DBus.system.signal_subscribe(
                BUS_NAME, iface, member, null, arg0,
                Gio.DBusSignalFlags.NONE, () => this._scheduleRefresh()));
        } catch (error) {
            Log.error("cannot watch BlueZ for " + member +
                      (arg0 ? " on " + arg0 : "") + ": " + error);
        }
    }

    /*
     * One read per burst. The first signal arms the timer and the rest of the
     * burst finds it armed, so twenty signals in a quarter of a second are one
     * GetManagedObjects rather than twenty.
     */
    _scheduleRefresh() {
        if (this.destroyed || this._refreshTimerId)
            return;
        this._refreshTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_SETTLE_MS, () => {
            this._refreshTimerId = 0;
            if (!this.destroyed)
                this._refresh();
            return GLib.SOURCE_REMOVE;
        });
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
        if (this._refreshTimerId) {
            GLib.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
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
