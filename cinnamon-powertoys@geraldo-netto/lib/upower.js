/*
 * cinnamon-powertoys - UPower client.
 *
 * Talks to org.freedesktop.UPower directly rather than through csd-power,
 * because the settings daemon only forwards a fixed tuple and drops the
 * interesting fields (energy rate, voltage, temperature, capacity, cycles).
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const UPowerGlib = imports.gi.UPowerGlib;

const Format = require("./lib/format.js");
const Log = require("./lib/log.js");
const OwnerWatch = require("./lib/owner-watch.js");

var BUS_NAME = "org.freedesktop.UPower";
var MANAGER_PATH = "/org/freedesktop/UPower";
var DISPLAY_DEVICE_PATH = "/org/freedesktop/UPower/devices/DisplayDevice";
var RETRY_INITIAL_MS = 500;
var RETRY_MAX_MS = 8000;

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
    <property name="LidIsClosed" type="b" access="read"/>\
    <property name="LidIsPresent" type="b" access="read"/>\
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

/*
 * The two proxies this monitor builds, gathered so that a caller can hand it
 * something else.
 *
 * Every other backend here takes its way out as a parameter - ddc.js a `run`,
 * bluez.js a `call`, privileged.js a `spawn`, profiles.js a bus - which is why
 * each of them has cases that run anywhere. This one built its proxies itself,
 * so the only thing that could exercise the enumerating, the counting and the
 * guards around them was a machine with UPower actually running, and CI has
 * neither UPower nor a system bus.
 *
 * Both are asynchronous, and deliberately: a proxy wrapper called without a
 * callback is the synchronous form, which is a connection and a GetAll round
 * trip taken on the thread that draws the desktop.
 * Gio and the wrappers are replaceable so this adapter can be checked without
 * a live bus.
 */
function systemBus(gio, managerProxy, deviceProxy) {
    gio = gio || Gio;
    managerProxy = managerProxy || ManagerProxy;
    deviceProxy = deviceProxy || DeviceProxy;
    return {
        watch: function (onAppeared, onVanished) {
            return gio.bus_watch_name(gio.BusType.SYSTEM, BUS_NAME,
                                      gio.BusNameWatcherFlags.AUTO_START,
                                      onAppeared, onVanished);
        },
        unwatch: function (id) {
            gio.bus_unwatch_name(id);
        },
        cancellable: function () {
            return new gio.Cancellable();
        },
        manager: function (onDone, cancellable) {
            new managerProxy(gio.DBus.system, BUS_NAME, MANAGER_PATH,
                             (proxy, error) => onDone(proxy, error),
                             cancellable || null);
        },
        device: function (path, onDone, cancellable) {
            new deviceProxy(gio.DBus.system, BUS_NAME, path,
                            (proxy, error) => onDone(proxy, error),
                            cancellable || null);
        },
    };
}

var UPowerMonitor = class UPowerMonitor {
    /*
     * onChanged is called whenever the device set or any device property
     * changes; onReady once the initial enumeration is complete. `bus` is how
     * the proxies are reached; see systemBus above.
     */
    constructor(onChanged, onReady, bus) {
        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._bus = bus || systemBus();
        this._devices = new Map();
        this._deviceSignals = new Map();
        /* Paths whose proxy has been asked for and has not arrived; see
         * _addDevice, which is where both of the reasons are. */
        this._adding = new Set();
        this._manager = null;
        this._display = null;
        this._busSignalIds = [];
        this._propSignalId = 0;
        this._displaySignalId = 0;
        this._ownerWatch = null;
        this._generation = 0;
        this._connecting = false;
        this._managerRequest = null;
        this._proxyRequests = new Set();
        this._retryTimerId = 0;
        this._retryDelay = RETRY_INITIAL_MS;
        this._failures = new Log.FailureLog();
        this._readySent = false;
        this.managerAvailable = false;
        this.available = false;
        this.destroyed = false;
        this._ownerPresent = this._bus.watch ? null : true;
        this._watchDegraded = false;

        if (this._bus.watch) {
            this._ownerWatch = new OwnerWatch.ResilientOwnerWatch({
                install: (appeared, vanished) => this._bus.watch(appeared, vanished),
                release: id => this._bus.unwatch(id),
                appeared: () => this._onNameAppeared(),
                vanished: () => this._onNameVanished(),
                onInstalled: () => { this._watchDegraded = false; },
                onFailed: () => { this._watchDegraded = true; },
                failures: this._failures,
                failureKey: "owner-watch",
                failureMessage: "cannot watch UPower",
                timers: {
                    add: (delay, callback) => this._bus.timeoutAdd
                        ? this._bus.timeoutAdd(delay, callback)
                        : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback),
                    remove: id => this._bus.removeTimer
                        ? this._bus.removeTimer(id) : GLib.source_remove(id),
                },
            });
            /* Ownership edges are optional for the initial state. Keep the
             * direct discovery path while registration is degraded. */
            if (!this._ownerWatch.start())
                this._connect();
        } else {
            this._connect();
        }
    }

    _settleReady() {
        if (this.destroyed || this._readySent)
            return;
        this._readySent = true;
        this._onReady();
    }

    _connect() {
        if (this.destroyed || this._manager || this._connecting)
            return;
        this._connecting = true;
        let generation = ++this._generation;
        let cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        let operation = { generation: generation, cancellable: cancellable };
        this._managerRequest = operation;
        try {
            this._bus.manager((proxy, error) =>
                this._onManagerReady(proxy, error, generation, operation), cancellable);
        } catch (e) {
            if (this._managerRequest !== operation)
                return;
            this._managerRequest = null;
            this._connecting = false;
            this._failures.report("manager", "cannot reach UPower: " + e);
            this._settleReady();
            this._scheduleRetry();
        }
    }

    _onManagerReady(proxy, error, generation, operation) {
        if (this._managerRequest !== operation)
            return;
        this._managerRequest = null;
        if (this.destroyed || generation !== this._generation)
            return;
        this._connecting = false;
        if (error || !proxy) {
            this._failures.report(
                "manager",
                "UPower manager unavailable: " + (error ? error.message : "no proxy"));
            this._settleReady();
            this._scheduleRetry();
            return;
        }
        this._failures.recover("manager");

        let busSignalIds = [];
        let propSignalId = 0;
        try {
            busSignalIds.push(proxy.connectSignal("DeviceAdded", (p, sender, [path]) => {
                if (generation === this._generation)
                    this._addDevice(path, null, generation);
            }));
            busSignalIds.push(proxy.connectSignal("DeviceRemoved", (p, sender, [path]) => {
                if (generation !== this._generation)
                    return;
                this._removeDevice(path);
                this._onChanged();
            }));
            propSignalId = proxy.connect("g-properties-changed", () => {
                if (generation === this._generation)
                    this._onChanged();
            });
        } catch (signalError) {
            for (let id of busSignalIds) {
                try {
                    proxy.disconnectSignal(id);
                } catch (e) {
                    /* The failed setup may already have removed it. */
                }
            }
            if (propSignalId) {
                try {
                    proxy.disconnect(propSignalId);
                } catch (e) {
                    /* Likewise. */
                }
            }
            this._failures.report(
                "manager-signals", "cannot subscribe to UPower manager: " + signalError);
            this._settleReady();
            this._scheduleRetry();
            return;
        }
        this._failures.recover("manager-signals");

        /* Publish only the fully wired proxy. _disconnectManager can now
         * always tear down every handler belonging to a visible manager. */
        this._manager = proxy;
        this._busSignalIds = busSignalIds;
        this._propSignalId = propSignalId;
        this.managerAvailable = true;
        this.available = false;
        let initialPending = 2;
        let initialFailed = false;
        let initialized = success => {
            if (this.destroyed || generation !== this._generation)
                return;
            if (!success)
                initialFailed = true;
            if (--initialPending > 0)
                return;
            if (initialFailed)
                this._scheduleRetry();
            else
                this._cancelRetry();
        };

        /*
         * The composite battery, which is the one the panel speaks for.
         *
         * It was the one proxy here built without a property handler. The
         * value was never stale - a proxy keeps its own cache in step with the
         * bus - but nobody was told it had moved, so the charge in the panel
         * waited for the poll or for one of the real batteries to change on
         * its own account. That happens to be most of the time, which is why
         * it went unnoticed; it is not the same thing as being told.
         */
        this._requestDevice(DISPLAY_DEVICE_PATH, (displayProxy, displayError) => {
            if (this.destroyed || generation !== this._generation)
                return;
            if (displayError || !displayProxy) {
                initialized(false);
                return;
            }
            let signalId;
            try {
                signalId = displayProxy.connect("g-properties-changed", () => {
                    if (generation === this._generation)
                        this._onChanged();
                });
            } catch (signalError) {
                this._failures.report(
                    "display-signals",
                    "cannot subscribe to UPower display device: " + signalError);
                initialized(false);
                return;
            }
            this._failures.recover("display-signals");
            this._display = displayProxy;
            this._displaySignalId = signalId;
            /* Enumeration can finish first and publish a physical battery as
             * the panel's fallback. Adopting the composite device changes
             * that answer just as surely as one of its properties changing. */
            this._onChanged();
            initialized(true);
        });

        let enumerated = (result, enumError) => {
            if (this.destroyed || generation !== this._generation)
                return;
            let paths = result && Array.isArray(result[0]) ? result[0] : null;
            if (enumError || !paths) {
                this.available = false;
                this._failures.report(
                    "enumerate",
                    "EnumerateDevices failed: " +
                    (enumError ? enumError.message : "invalid reply"));
                this._settleReady();
                this._onChanged();
                initialized(false);
                return;
            }
            this._failures.recover("enumerate");
            let pending = paths.length;
            if (pending === 0) {
                this.available = true;
                this._settleReady();
                this._onChanged();
                initialized(true);
                return;
            }
            let failed = false;
            for (let path of paths)
                this._addDevice(path, success => {
                    if (!success)
                        failed = true;
                    if (--pending > 0)
                        return;
                    /* The applet can be removed while the enumeration is still
                     * being answered, and the last answer arriving is not a
                     * reason to call back into a menu that has been taken
                     * down. Every other guard in here says the same. */
                    if (this.destroyed || generation !== this._generation)
                        return;
                    this.available = !failed;
                    this._settleReady();
                    this._onChanged();
                    initialized(!failed);
                }, generation);
        };
        try {
            proxy.EnumerateDevicesRemote(enumerated);
        } catch (error) {
            enumerated(null, error);
        }
    }

    _onNameAppeared() {
        if (this.destroyed)
            return;
        this._ownerPresent = true;
        this._cancelRetry();
        this._connect();
    }

    _onNameVanished() {
        if (this.destroyed)
            return;
        this._ownerPresent = false;
        this._failures.clear();
        this._cancelRetry();
        let changed = this.available || this._manager !== null ||
                      this._devices.size > 0 || this._display !== null;
        this._disconnectManager();
        this._settleReady();
        if (changed)
            this._onChanged();
    }

    _scheduleRetry() {
        if (this.destroyed ||
                (this._ownerPresent !== true && !this._watchDegraded) ||
                this._retryTimerId)
            return;
        let delay = this._retryDelay;
        this._retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
        let callback = () => {
            this._retryTimerId = 0;
            if (!this.destroyed &&
                    (this._ownerPresent === true || this._watchDegraded)) {
                let changed = this.available || this._devices.size > 0 || this._display !== null;
                this._disconnectManager();
                if (changed)
                    this._onChanged();
                this._connect();
            }
            return GLib.SOURCE_REMOVE;
        };
        this._retryTimerId = this._bus.timeoutAdd
            ? this._bus.timeoutAdd(delay, callback)
            : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback);
    }

    _cancelRetry() {
        if (this._retryTimerId) {
            if (this._bus.removeTimer)
                this._bus.removeTimer(this._retryTimerId);
            else
                GLib.source_remove(this._retryTimerId);
            this._retryTimerId = 0;
        }
        this._retryDelay = RETRY_INITIAL_MS;
    }

    /* Proxy wrappers normally report failure to their callback, but reaching
     * the bus and constructing the wrapper can throw before one is installed.
     * Turn both routes into the one exactly-once contract every caller uses. */
    _requestDevice(path, onDone) {
        let settled = false;
        let cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        let operation = { path: path, cancellable: cancellable, finish: null };
        let finish = (proxy, error) => {
            if (settled || !this._proxyRequests.delete(operation))
                return;
            settled = true;
            onDone(proxy, error);
        };
        operation.finish = finish;
        this._proxyRequests.add(operation);
        try {
            this._bus.device(path, finish, cancellable);
        } catch (error) {
            finish(null, error);
        }
    }

    _cancelManagerRequest() {
        let operation = this._managerRequest;
        this._managerRequest = null;
        this._connecting = false;
        if (operation && operation.cancellable) {
            try {
                operation.cancellable.cancel();
            } catch (e) {
                /* already cancelled */
            }
        }
    }

    _cancelProxyRequests(path) {
        let operations = Array.from(this._proxyRequests).filter(operation =>
            path === undefined || operation.path === path);
        for (let operation of operations) {
            if (operation.cancellable) {
                try {
                    operation.cancellable.cancel();
                } catch (e) {
                    /* already cancelled */
                }
            }
            /* Settle enumeration counters now; the real cancellation reply is
             * ignored by the exactly-once guard when it eventually arrives. */
            operation.finish(null, new Error("UPower proxy request cancelled"));
        }
    }

    /*
     * One proxy per path, counting the one that is on its way.
     *
     * The guard used to be the map alone, and the map is only written when the
     * answer comes back - so for the whole round trip a path read as unknown
     * however many times it was announced, and two things went wrong in that
     * window.
     *
     * A path announced twice inside it - the enumeration racing a DeviceAdded,
     * a dock reconnecting - built two proxies. The second took the map entry
     * and the first kept its g-properties-changed handler, so every property
     * change was two redraws for the rest of the session, and destroy() could
     * not reach the orphan because the map no longer named it.
     *
     * A DeviceRemoved inside it found nothing to remove, and the answer landed
     * afterwards: a headset switched off while it was being proxied kept its
     * menu row until the applet was reloaded. So a removal disowns the ask,
     * and an answer nobody is waiting for any more is dropped rather than
     * adopted.
     */
    _addDevice(path, done, generation) {
        generation = generation === undefined ? this._generation : generation;
        let settle = success => {
            if (done)
                done(success);
        };

        if (this._devices.has(path) || this._adding.has(path)) {
            settle(true);
            return;
        }

        this._adding.add(path);
        this._requestDevice(path, (proxy, error) => {
            if (generation !== this._generation) {
                settle(false);
                return;
            }
            /* False where the device went away while this was in flight, which
             * is _removeDevice having taken the path back out. */
            let wanted = this._adding.delete(path);
            if (this.destroyed || !wanted) {
                settle(false);
                return;
            }
            if (error || !proxy) {
                if (!done) {
                    this.available = false;
                    this._onChanged();
                    this._scheduleRetry();
                }
                settle(false);
                return;
            }
            let changed = () => this._onChanged();
            let signalId;
            try {
                signalId = proxy.connect("g-properties-changed", changed);
            } catch (error) {
                if (!done) {
                    this.available = false;
                    this._onChanged();
                    this._scheduleRetry();
                }
                settle(false);
                return;
            }
            this._devices.set(path, proxy);
            this._deviceSignals.set(path, signalId);
            if (done)
                done(true);
            else
                this._onChanged();
        });
    }

    /* Devices come and go all the time (bluetooth, docks, USB), so the
     * property handler has to go with them or it accumulates for the life of
     * the session - and one that is still being proxied has to be taken off
     * the list of asks, or its answer arrives and puts it back. */
    _removeDevice(path) {
        this._adding.delete(path);
        this._cancelProxyRequests(path);
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

    /* UPower says both whether this machine has a lid and whether that lid is
     * closed. Requiring both keeps a missing property, an old daemon or a
     * desktop at the conservative answer: do not reinterpret a built-in
     * backlight as an external-only display topology. */
    get lidIsClosed() {
        return this._manager ? this._manager.LidIsPresent === true &&
                               this._manager.LidIsClosed === true : false;
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
     * Everything this monitor holds, described once.
     *
     * A description is nineteen properties, and a property on a proxy is a
     * cached variant looked up and unpacked - so the walk is the cost here,
     * not the loop around it. A poll used to take it twice over: snapshot()
     * described every device and then lineDevices() walked the same map again
     * and described the chargers a second time. Same shape as the double
     * unpack lib/profiles.js closed with its own snapshot().
     */
    _describeAll() {
        let devices = [];
        for (let [path, proxy] of this._devices)
            devices.push(this._describe(proxy, path));
        return devices;
    }

    _lineDevices(devices) {
        return devices.filter(device => device.kind === UPDeviceKind.LINE_POWER);
    }

    /*
     * Every device that carries a charge, batteries first, then peripherals.
     * Which those are, and what order they come in, is reportedDevices - a
     * function of the descriptions, and so something that can be held to
     * without a bus.
     */
    snapshot() {
        return reportedDevices(this._describeAll());
    }

    lineDevices() {
        return this._lineDevices(this._describeAll());
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

    /* Everything the applet takes from UPower, as of now, from one walk of
     * what it holds - see _describeAll for why that is worth saying. */
    read() {
        let described = this._describeAll();
        let devices = reportedDevices(described);
        let lines = this._lineDevices(described);
        let readings = sensorReadings(devices);
        return {
            available: this.available,
            devices: devices,
            lines: lines,
            primary: this._primaryDevice(devices),
            onBattery: this.onBattery,
            temperatures: readings.temperatures,
            powers: readings.powers,
        };
    }

    _disconnectManager() {
        ++this._generation;
        this._cancelManagerRequest();
        this._cancelProxyRequests();
        this.managerAvailable = false;
        this.available = false;
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
        if (this._display && this._displaySignalId) {
            try {
                this._display.disconnect(this._displaySignalId);
            } catch (e) {
                /* already gone */
            }
        }

        this._busSignalIds = [];
        this._propSignalId = 0;
        this._displaySignalId = 0;

        for (let path of Array.from(this._devices.keys()))
            this._removeDevice(path);
        /* Whatever is still on its way is not wanted; the destroyed flag turns
         * each of those answers away, and this leaves nothing behind saying it
         * was expected. */
        this._adding.clear();

        this._manager = null;
        this._display = null;
    }

    destroy() {
        this.destroyed = true;
        this._cancelRetry();
        if (this._ownerWatch)
            this._ownerWatch.stop();
        /* Every other backend here lowers this on the way out, and a reading
         * taken from a torn down monitor would otherwise say UPower is
         * available and hand back no devices at all. */
        this._disconnectManager();
    }
};
