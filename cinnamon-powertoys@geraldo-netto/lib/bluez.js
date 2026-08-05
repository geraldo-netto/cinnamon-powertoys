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
const OwnerWatch = require("./lib/owner-watch.js");

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

const WATCHED_PROPERTIES = {
    "org.bluez.Device1": ["Connected", "Alias", "Name", "Icon"],
    "org.bluez.Battery1": ["Percentage"],
};

/*
 * How long a burst of signals which could not be decoded is allowed to settle
 * before the tree is read again.
 *
 * Normal Device1 and Battery1 signals carry enough data to update the cache
 * directly, and properties such as RSSI are ignored. The timer is only the
 * conservative recovery path for a relevant signal with an unexpected shape:
 * long enough to gather a burst into one read, short enough that nobody
 * watching the menu sees the wait.
 */
var REFRESH_SETTLE_MS = 250;
var RETRY_INITIAL_MS = 500;
var RETRY_MAX_MS = 8000;
var DEGRADED_INITIAL_MS = 1000;
var DEGRADED_MAX_MS = 30000;

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

/* Watches ownership rather than any one BlueZ object. Object/property signals
 * cannot report an abrupt daemon exit, because the process that would emit
 * them has already gone. The returned function releases the watch. */
function systemNameWatcher(onAppeared, onVanished, bus) {
    let adapter = bus || Gio;
    let id = adapter.bus_watch_name(
        Gio.BusType.SYSTEM, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
        () => onAppeared(), () => onVanished());
    if (!id)
        throw new Error("BlueZ ownership watch returned no id");
    return function () {
        adapter.bus_unwatch_name(id);
    };
}
/* Gio's name watcher always reports the current owner after registration.
 * Injected watchers are not assumed to have that contract. */
systemNameWatcher.reportsInitialState = true;

/*
 * Watches BlueZ for connected devices that report a battery.
 *
 * The object tree is asked for once and then kept in step by the signals
 * BlueZ emits as devices come, go and change, so a poll costs nothing.
 */
var BluezBatteries = class BluezBatteries {
    constructor(onChanged, call, watchName, signalBus, timers) {
        this.available = false;
        this.destroyed = false;
        this.devices = [];

        this._onChanged = onChanged || function () {};
        this._call = call || ((path, iface, method, onDone, cancellable) =>
            this._dbusCall(path, iface, method, onDone, cancellable));
        /* A custom call owns its own environment unless it supplies the
         * matching name watcher too. Production supplies neither. */
        this._watchName = watchName === undefined
            ? (call ? null : systemNameWatcher) : watchName;
        this._signalBus = signalBus || null;
        this._timers = timers || GLib;
        this._ownerWatch = null;
        this._signalIds = [];
        this._signalKeys = new Set();
        this._refreshTimerId = 0;
        this._retryTimerId = 0;
        this._retryDelay = RETRY_INITIAL_MS;
        this._failures = new Log.FailureLog();
        if (this._watchName) {
            this._ownerWatch = new OwnerWatch.ResilientOwnerWatch({
                install: (appeared, vanished) =>
                    this._watchName(appeared, vanished),
                release: unwatch => unwatch(),
                appeared: () => this._ownerAppeared(),
                vanished: () => this._ownerVanished(),
                failures: this._failures,
                failureKey: "owner-watch",
                failureMessage: "cannot watch ownership of BlueZ",
                timers: {
                    add: (delay, callback) => this._timers.timeout_add(
                        GLib.PRIORITY_DEFAULT, delay, callback),
                    remove: id => this._timers.source_remove(id),
                },
            });
        }
        this._degradedTimerId = 0;
        this._degradedDelay = DEGRADED_INITIAL_MS;
        /* The last complete object tree is the base to which signal deltas
         * are applied. Before it arrives, a relevant signal requests one
         * follow-up snapshot so no startup race can leave the cache stale. */
        this._objects = {};
        this._cacheReady = false;
        this._read = null;
        this._readAgain = false;
        /* Invalidates an answer that crossed a daemon stop or restart. */
        this._ownerEpoch = 0;
        /* Only a positive ownership edge authorizes automatic retries. A
         * custom transport without a watcher retains its one direct read. */
        this._ownerPresent = null;

        let signalsReady = this._watch();
        let ownerDriven = this._watchName &&
                          this._watchName.reportsInitialState === true;
        let watching = this._watchOwner();
        /* Production gets its first read from the owner's initial appeared
         * callback. Injected transports and a failed watch retain the direct
         * startup path expected by integrations and tests. */
        if (!ownerDriven || !watching)
            this._refresh();
        if (!signalsReady)
            this._scheduleDegradedPoll();
    }

    /*
     * The reach for the bus is inside the try as well as the reply.
     *
     * Gio.DBus.system is a getter that connects, and on a machine with no
     * system bus at all it throws rather than answering - which is why
     * lib/upower.js wraps its own, why _subscribe below wraps its, and why
     * tests/cases/live.js asks the same question in a try before it decides
     * whether it can run. This one was the reach that was not wrapped, and it
     * is called from the constructor, so the throw would have come up through
     * the applet's constructor and left nothing on the panel at all.
     *
     * Both routes preserve the error beside the empty result. The ownership-
     * aware caller can then diagnose a broken owned daemon without mistaking
     * an ordinary desktop with no bluetoothd for a fault.
     */
    _dbusCall(path, iface, method, onDone, cancellable) {
        try {
            Gio.DBus.system.call(BUS_NAME, path, iface, method, null, null,
                                 Gio.DBusCallFlags.NONE, -1, cancellable || null,
                                 (connection, result) => {
                                     try {
                                         onDone(connection.call_finish(result).deepUnpack()[0]);
                                     } catch (error) {
                                         onDone(null, error);
                                     }
                                 });
        } catch (error) {
            onDone(null, error);
        }
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
        if (this.destroyed)
            return;
        if (this._read) {
            this._readAgain = true;
            return;
        }
        let cancellable = null;
        try {
            cancellable = new Gio.Cancellable();
        } catch (error) {
            /* An injected runtime without cancellables still has generation
             * guards; cancellation is an optimization, not correctness. */
        }
        let operation = { epoch: this._ownerEpoch, cancellable: cancellable };
        this._read = operation;
        let finish = (objects, error) => {
            if (this._read !== operation)
                return;
            this._read = null;
            if (this.destroyed)
                return;
            let failed = false;
            if (operation.epoch === this._ownerEpoch) {
                let valid = objects && typeof objects === "object" &&
                            !Array.isArray(objects);
                this.available = !!valid;
                this._objects = valid ? objects : {};
                this._cacheReady = !!valid;
                this._settle(valid ? parseObjects(this._objects) : []);
                if (valid) {
                    this._failures.recover("snapshot");
                    this._cancelRetry();
                } else {
                    if (this._ownerPresent === true) {
                        this._failures.report(
                            "snapshot", "cannot read BlueZ object tree: " +
                            (error || "invalid reply"));
                    }
                    failed = true;
                }
            }
            let again = this._readAgain;
            this._readAgain = false;
            if (again)
                this._refresh();
            else if (failed)
                this._scheduleRetry();
        };
        try {
            this._call("/", "org.freedesktop.DBus.ObjectManager",
                       "GetManagedObjects", finish, cancellable);
        } catch (error) {
            finish(null, error);
        }
    }

    _cancelRead() {
        let operation = this._read;
        this._read = null;
        this._readAgain = false;
        if (operation && operation.cancellable) {
            try {
                operation.cancellable.cancel();
            } catch (error) {
                /* already cancelled */
            }
        }
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
     * A device coming or going, and a displayed property changing on one of
     * the two interfaces this module parses. Each signal updates the cached
     * tree in place; unrelated interfaces and properties never reach a read.
     */
    _watch() {
        let complete = true;
        complete = this._subscribe(
            "org.freedesktop.DBus.ObjectManager", "InterfacesAdded", null,
            (path, args) => this._interfacesAdded(args)) && complete;
        complete = this._subscribe(
            "org.freedesktop.DBus.ObjectManager", "InterfacesRemoved", null,
            (path, args) => this._interfacesRemoved(args)) && complete;
        for (let iface of WATCHED_INTERFACES)
            complete = this._subscribe(
                "org.freedesktop.DBus.Properties", "PropertiesChanged", iface,
                (path, args) => this._propertiesChanged(path, args)) && complete;
        return complete;
    }

    _watchOwner() {
        return this._ownerWatch ? this._ownerWatch.start() : false;
    }

    _ownerAppeared() {
        if (this.destroyed)
            return;
        this._ownerPresent = true;
        this._ownerEpoch++;
        this._cancelRead();
        this._cancelRetry();
        this._objects = {};
        this._cacheReady = false;
        this._refresh();
    }

    _ownerVanished() {
        if (this.destroyed)
            return;
        this._ownerPresent = false;
        this._failures.clear();
        this._ownerEpoch++;
        this._cancelRead();
        this._cancelRetry();
        this.available = false;
        this._objects = {};
        this._cacheReady = false;
        if (this._refreshTimerId) {
            this._timers.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        this._settle([]);
    }

    _subscribe(iface, member, arg0, onSignal) {
        let key = iface + "|" + member + "|" + (arg0 || "");
        if (this._signalKeys.has(key))
            return true;
        try {
            let connection = this._signalBus || Gio.DBus.system;
            let id = connection.signal_subscribe(
                BUS_NAME, iface, member, null, arg0,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, signalIface, signal, parameters) => {
                    if (this.destroyed)
                        return;
                    try {
                        let args = parameters &&
                                   typeof parameters.deepUnpack === "function"
                            ? parameters.deepUnpack() : parameters;
                        onSignal(path, Array.isArray(args) ? args : []);
                    } catch (error) {
                        /* A signal with an unexpected shape must not make the
                         * cache permanently stale. One snapshot repairs it. */
                        this._scheduleRefresh();
                    }
                });
            if (!id)
                throw new Error("subscription returned no id");
            this._signalIds.push(id);
            this._signalKeys.add(key);
            this._failures.recover("signal:" + key);
            return true;
        } catch (error) {
            this._failures.report(
                "signal:" + key,
                "cannot watch BlueZ for " + member +
                (arg0 ? " on " + arg0 : "") + ": " + error);
            return false;
        }
    }

    _needSnapshot() {
        if (this._read)
            this._readAgain = true;
        else
            this._refresh();
    }

    _interfacesAdded(args) {
        let path = args[0];
        let added = args[1];
        if (typeof path !== "string" || !added || typeof added !== "object")
            return;
        let relevant = WATCHED_INTERFACES.filter(iface =>
            Object.prototype.hasOwnProperty.call(added, iface));
        if (relevant.length === 0)
            return;
        if (!this._cacheReady) {
            this._needSnapshot();
            return;
        }
        let interfaces = this._objects[path] || {};
        for (let iface of relevant)
            interfaces[iface] = added[iface];
        this._objects[path] = interfaces;
        this._settle(parseObjects(this._objects));
    }

    _interfacesRemoved(args) {
        let path = args[0];
        let removed = args[1];
        if (typeof path !== "string" || !Array.isArray(removed) ||
            !removed.some(iface => WATCHED_INTERFACES.indexOf(iface) >= 0))
            return;
        if (!this._cacheReady) {
            this._needSnapshot();
            return;
        }
        let interfaces = this._objects[path];
        if (!interfaces)
            return;
        for (let iface of removed)
            delete interfaces[iface];
        if (Object.keys(interfaces).length === 0)
            delete this._objects[path];
        this._settle(parseObjects(this._objects));
    }

    _propertiesChanged(path, args) {
        let iface = args[0];
        let changed = args[1];
        let invalidated = args[2];
        let watched = WATCHED_PROPERTIES[iface];
        if (typeof path !== "string" || !watched || !changed ||
            typeof changed !== "object")
            return;
        invalidated = Array.isArray(invalidated) ? invalidated : [];
        let relevant = watched.some(property =>
            Object.prototype.hasOwnProperty.call(changed, property) ||
            invalidated.indexOf(property) >= 0);
        if (!relevant)
            return;
        if (!this._cacheReady) {
            this._needSnapshot();
            return;
        }
        let interfaces = this._objects[path];
        if (!interfaces || !interfaces[iface]) {
            this._needSnapshot();
            return;
        }
        let properties = interfaces[iface];
        let needsRepair = false;
        for (let property of watched) {
            if (Object.prototype.hasOwnProperty.call(changed, property))
                properties[property] = changed[property];
            if (invalidated.indexOf(property) >= 0)
                needsRepair = true;
        }
        this._settle(parseObjects(this._objects));
        /* An invalidated value is not a deletion. BlueZ is saying that the
         * value in this signal cannot be used and must be fetched again, so
         * retain the last complete row until one coalesced snapshot repairs
         * it. Deleting Connected or Percentage here can otherwise make a
         * live battery disappear until an unrelated signal happens. */
        if (needsRepair)
            this._scheduleRefresh();
    }

    /*
     * One recovery read per malformed-signal burst. The first arms the timer
     * and the rest find it armed, so twenty undecodable signals in a quarter
     * of a second are one GetManagedObjects rather than twenty.
     */
    _scheduleRefresh() {
        if (this.destroyed || this._refreshTimerId)
            return;
        this._refreshTimerId = this._timers.timeout_add(
            GLib.PRIORITY_DEFAULT, REFRESH_SETTLE_MS, () => {
            this._refreshTimerId = 0;
            if (!this.destroyed)
                this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Retry a transient GetManagedObjects failure only while the ownership
     * watcher still says this daemon exists. The delay is capped so recovery
     * remains possible without turning an unhealthy bus into a tight loop. */
    _scheduleRetry() {
        if (this.destroyed || this._ownerPresent !== true || this._retryTimerId)
            return;
        let delay = this._retryDelay;
        this._retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
        this._retryTimerId = this._timers.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._retryTimerId = 0;
                if (!this.destroyed && this._ownerPresent === true)
                    this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelRetry() {
        if (this._retryTimerId) {
            this._timers.source_remove(this._retryTimerId);
            this._retryTimerId = 0;
        }
        this._retryDelay = RETRY_INITIAL_MS;
    }

    _repairWiring() {
        return this._watch();
    }

    /* Missing signal edges turn the cache into a polled one until those
     * registrations can be restored. Ownership registration has its own
     * resilient boundary. The interval backs off to a fixed
     * ceiling: enough to avoid hammering a broken bus, never long enough to
     * leave a changed device stale for the rest of the session. */
    _scheduleDegradedPoll() {
        if (this.destroyed || this._degradedTimerId)
            return;
        this._cancelRetry();
        let delay = this._degradedDelay;
        this._degradedDelay = Math.min(delay * 2, DEGRADED_MAX_MS);
        this._degradedTimerId = this._timers.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._degradedTimerId = 0;
                let repaired = this._repairWiring();
                /* With a working owner watcher, absence is already known and
                 * there is no daemon to poll. An unknown owner still needs the
                 * conservative snapshot attempt. */
                if (this._ownerPresent !== false)
                    this._refresh();
                if (repaired)
                    this._degradedDelay = DEGRADED_INITIAL_MS;
                else
                    this._scheduleDegradedPoll();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelDegradedPoll() {
        if (this._degradedTimerId) {
            this._timers.source_remove(this._degradedTimerId);
            this._degradedTimerId = 0;
        }
        this._degradedDelay = DEGRADED_INITIAL_MS;
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
        this._cancelRead();
        this._cancelRetry();
        this._cancelDegradedPoll();
        if (this._refreshTimerId) {
            this._timers.source_remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._ownerWatch)
            this._ownerWatch.stop();
        for (let id of this._signalIds) {
            try {
                let connection = this._signalBus || Gio.DBus.system;
                connection.signal_unsubscribe(id);
            } catch (error) {
                /* already gone */
            }
        }
        this._signalIds = [];
        this._signalKeys.clear();
        this._objects = {};
        this._cacheReady = false;
        this.devices = [];
        this.available = false;
    }
};
