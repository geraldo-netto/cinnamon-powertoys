/*
 * cinnamon-powertoys - UPower client.
 *
 * Talks to org.freedesktop.UPower directly rather than through csd-power,
 * because the settings daemon only forwards a fixed tuple and drops the
 * interesting fields (energy rate, voltage, temperature, capacity, cycles).
 */

const Gio = imports.gi.Gio;
const UPowerGlib = imports.gi.UPowerGlib;

const Bus = require("./lib/bus.js");
const Device = require("./lib/device.js");
const Log = require("./lib/log.js");
const Once = require("./lib/once.js");
const OwnerWatch = require("./lib/owner-watch.js");
const Backoff = require("./lib/backoff.js");

const BUS_NAME = "org.freedesktop.UPower";
const MANAGER_PATH = "/org/freedesktop/UPower";
const DISPLAY_DEVICE_PATH = "/org/freedesktop/UPower/devices/DisplayDevice";

const MANAGER_XML = '<node>' +
    '<interface name="org.freedesktop.UPower">' +
        '<method name="EnumerateDevices">' +
            '<arg type="ao" direction="out" name="devices"/>' +
        '</method>' +
        '<method name="GetDisplayDevice">' +
            '<arg type="o" direction="out" name="device"/>' +
        '</method>' +
        '<signal name="DeviceAdded"><arg type="o" name="device"/></signal>' +
        '<signal name="DeviceRemoved"><arg type="o" name="device"/></signal>' +
        '<property name="OnBattery" type="b" access="read"/>' +
        '<property name="LidIsClosed" type="b" access="read"/>' +
        '<property name="LidIsPresent" type="b" access="read"/>' +
    '</interface>' +
    '</node>';

const DEVICE_XML = '<node>' +
    '<interface name="org.freedesktop.UPower.Device">' +
        '<property name="Vendor" type="s" access="read"/>' +
        '<property name="Model" type="s" access="read"/>' +
        '<property name="Type" type="u" access="read"/>' +
        '<property name="PowerSupply" type="b" access="read"/>' +
        '<property name="Online" type="b" access="read"/>' +
        '<property name="Energy" type="d" access="read"/>' +
        '<property name="EnergyFull" type="d" access="read"/>' +
        '<property name="EnergyRate" type="d" access="read"/>' +
        '<property name="Voltage" type="d" access="read"/>' +
        '<property name="ChargeCycles" type="i" access="read"/>' +
        '<property name="Temperature" type="d" access="read"/>' +
        '<property name="TimeToEmpty" type="x" access="read"/>' +
        '<property name="TimeToFull" type="x" access="read"/>' +
        '<property name="Percentage" type="d" access="read"/>' +
        '<property name="IsPresent" type="b" access="read"/>' +
        '<property name="State" type="u" access="read"/>' +
        '<property name="Capacity" type="d" access="read"/>' +
        '<property name="BatteryLevel" type="u" access="read"/>' +
        '<property name="IconName" type="s" access="read"/>' +
    '</interface>' +
    '</node>';

const UPDeviceKind = UPowerGlib.DeviceKind;
const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

function _number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    /* Built here rather than at the top of the file, and through lib/bus.js
     * rather than beside it. The two classes used to be module level
     * constants, which ran `Gio.DBusProxy.makeProxyWrapper` at import time -
     * before any caller had said which runtime it meant, so the one line that
     * had to honour an injected Gio could not, and the port that says it is
     * the only way this applet reaches a daemon had an exception in it. A
     * wrapper is a class built from a string; building it when a bus is asked
     * for costs one construction per monitor. */
    managerProxy = managerProxy || Bus.wrapperFor(MANAGER_XML, gio);
    deviceProxy = deviceProxy || Bus.wrapperFor(DEVICE_XML, gio);
    return {
        watch: function (onAppeared, onVanished) {
            return Bus.watch(BUS_NAME, onAppeared, onVanished,
                             { gio: gio, autoStart: true });
        },
        unwatch: function (id) {
            Bus.release(id, gio);
        },
        cancellable: function () {
            return Bus.cancellable(gio);
        },
        manager: function (onDone, cancellable) {
            return Bus.proxy(managerProxy, BUS_NAME, MANAGER_PATH, onDone,
                             { gio: gio, cancellable: cancellable });
        },
        device: function (path, onDone, cancellable) {
            return Bus.proxy(deviceProxy, BUS_NAME, path, onDone,
                             { gio: gio, cancellable: cancellable });
        },
    };
}

const UPowerMonitor = class UPowerMonitor {
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
        this._retry = new Backoff.Backoff({
            timers: this._bus,
            initialMs: Backoff.BUS_INITIAL_MS,
            maxMs: Backoff.BUS_MAX_MS,
            allow: () => !this.destroyed &&
                (this._ownerPresent === true || this._watchDegraded),
            run: () => {
                let changed = this.available || this._devices.size > 0 ||
                    this._display !== null;
                this._disconnectManager();
                if (changed)
                    this._onChanged();
                this._connect();
            },
        });
        this._failures = new Log.FailureLog();
        this._readySent = false;
        this.managerAvailable = false;
        this.available = false;
        this.destroyed = false;
        this._ownerPresent = this._bus.watch ? null : true;
        this._watchDegraded = false;

        if (this._bus.watch) {
            this._ownerWatch = OwnerWatch.watchOwnership({
                install: (appeared, vanished) => this._bus.watch(appeared, vanished),
                release: id => this._bus.unwatch(id),
                appeared: () => this._onNameAppeared(),
                vanished: () => this._onNameVanished(),
                onInstalled: () => { this._watchDegraded = false; },
                onFailed: () => { this._watchDegraded = true; },
                failures: this._failures,
                failureKey: "owner-watch",
                failureMessage: "cannot watch UPower",
                timers: this._bus,
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

        let signals = this._connectManagerSignals(proxy, generation);
        if (!signals) {
            this._settleReady();
            this._scheduleRetry();
            return;
        }
        this._failures.recover("manager-signals");

        /* Publish only the fully wired proxy. _disconnectManager can now
         * always tear down every handler belonging to a visible manager. */
        this._manager = proxy;
        this._busSignalIds = signals.bus;
        this._propSignalId = signals.properties;
        this.managerAvailable = true;
        this.available = false;
        let initialized = this._managerInitialization(generation);
        this._connectDisplay(generation, initialized);
        let enumerated = (result, error) =>
            this._onEnumerated(result, error, generation, initialized);
        try {
            proxy.EnumerateDevicesRemote(enumerated);
        } catch (error) {
            enumerated(null, error);
        }
    }

    _connectManagerSignals(proxy, generation) {
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
            this._disconnectSignals(proxy, busSignalIds, propSignalId);
            this._failures.report(
                "manager-signals", "cannot subscribe to UPower manager: " + signalError);
            return null;
        }
        return { bus: busSignalIds, properties: propSignalId };
    }

    _managerInitialization(generation) {
        let initialPending = 2;
        let initialFailed = false;
        return success => {
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
    }

    _connectDisplay(generation, initialized) {
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
    }

    _onEnumerated(result, error, generation, initialized) {
        if (this.destroyed || generation !== this._generation)
            return;
        let paths = result && Array.isArray(result[0]) ? result[0] : null;
        if (error || !paths) {
            this.available = false;
            this._failures.report(
                "enumerate",
                "EnumerateDevices failed: " +
                (error ? error.message : "invalid reply"));
            this._settleReady();
            this._onChanged();
            initialized(false);
            return;
        }
        this._failures.recover("enumerate");
        this._adoptEnumeratedPaths(paths, generation, initialized);
    }

    _adoptEnumeratedPaths(paths, generation, initialized) {
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
                 * being answered, and the last answer arriving is not a reason
                 * to call back into a menu that has been taken down. */
                if (this.destroyed || generation !== this._generation)
                    return;
                this.available = !failed;
                this._settleReady();
                this._onChanged();
                initialized(!failed);
            }, generation);
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
        this._retry.schedule();
    }

    _cancelRetry() {
        this._retry.cancel();
    }

    /* Proxy wrappers normally report failure to their callback, but reaching
     * the bus and constructing the wrapper can throw before one is installed.
     * Turn both routes into the one exactly-once contract every caller uses. */
    _requestDevice(path, onDone) {
        let cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        let operation = { path: path, cancellable: cancellable, finish: null };
        /* The request stops being outstanding at the moment it answers,
         * whichever route it answered by. It cannot answer twice - the once
         * wrapper closes it - and a cancellation settles it here as well, so
         * there is one place the set is written and one answer per request. */
        let finish = Once.once((proxy, error) => {
            this._proxyRequests.delete(operation);
            onDone(proxy, error);
        });
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
        if (operation?.cancellable) {
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
                this._dropAnnouncedDevice(
                    path, done,
                    "cannot proxy " + path + ": " +
                    (error ? error.message : "no proxy"));
                settle(false);
                return;
            }
            let changed = () => this._onChanged();
            let signalId;
            try {
                signalId = proxy.connect("g-properties-changed", changed);
            } catch (signalError) {
                this._dropAnnouncedDevice(
                    path, done,
                    "cannot subscribe to " + path + ": " + signalError);
                settle(false);
                return;
            }
            this._failures.recover("device:" + path);
            this._devices.set(path, proxy);
            this._deviceSignals.set(path, signalId);
            if (done)
                done(true);
            else
                this._onChanged();
        });
    }

    /*
     * One announced device that could not be proxied is one device, not the
     * daemon.
     *
     * This used to set available = false and call _scheduleRetry(), whose
     * timer runs _disconnectManager() - the manager, the display device and
     * every device proxy dropped and rebuilt from scratch. The ordinary
     * trigger is entirely benign: a bluetooth peripheral that disconnects
     * between DeviceAdded and the proxy's reply. One peripheral flickering
     * blanked the whole battery list.
     *
     * So the path is simply not adopted and the trouble is reported under a
     * key of its own, which recovers by itself when the same path is proxied
     * later. Manager-level failures - _onManagerReady, _onEnumerated - keep
     * available = false and the retry, because there the daemon really is the
     * thing that did not answer.
     *
     * An enumeration walk passes a `done`, and it already reports its own
     * outcome to the caller, so it is only told.
     */
    _dropAnnouncedDevice(path, done, message) {
        this._failures.report("device:" + path, message);
        if (!done)
            this._onChanged();
    }

    /* Devices come and go all the time (bluetooth, docks, USB), so the
     * property handler has to go with them or it accumulates for the life of
     * the session - and one that is still being proxied has to be taken off
     * the list of asks, or its answer arrives and puts it back. */
    _removeDevice(path) {
        this._failures.recover("device:" + path);
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
     * Which those are, and what order they come in, is Device.reportedDevices - a
     * function of the descriptions, and so something that can be held to
     * without a bus.
     */
    snapshot() {
        return Device.reportedDevices(this._describeAll());
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
     * what it holds - see _describeAll for why that is worth saying. Devices,
     * not rows: what the batteries look like in the sensor list is
     * SensorRows.batteryReadings, and it is not this module's business. */
    read() {
        let described = this._describeAll();
        let devices = Device.reportedDevices(described);
        return {
            available: this.available,
            devices: devices,
            lines: this._lineDevices(described),
            primary: this._primaryDevice(devices),
            onBattery: this.onBattery,
        };
    }

    _disconnectSignals(proxy, busSignalIds, propSignalId) {
        for (let id of busSignalIds) {
            try { proxy.disconnectSignal(id); } catch (e) { /* already gone */ }
        }
        if (propSignalId) {
            try { proxy.disconnect(propSignalId); } catch (e) { /* already gone */ }
        }
    }

    _disconnectManagerHandlers() {
        if (this._manager)
            this._disconnectSignals(this._manager, this._busSignalIds, this._propSignalId);
    }

    _disconnectDisplayHandler() {
        if (this._display && this._displaySignalId) {
            try {
                this._display.disconnect(this._displaySignalId);
            } catch (e) {
                /* already gone */
            }
        }
    }

    _disconnectManager() {
        ++this._generation;
        this._cancelManagerRequest();
        this._cancelProxyRequests();
        this.managerAvailable = false;
        this.available = false;
        this._disconnectManagerHandlers();
        this._disconnectDisplayHandler();

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
        Log.release("the UPower retry", () => this._cancelRetry());
        if (this._ownerWatch)
            Log.release("the UPower owner watch", () => this._ownerWatch.stop());
        /* Every other backend here lowers this on the way out, and a reading
         * taken from a torn down monitor would otherwise say UPower is
         * available and hand back no devices at all. */
        Log.release("the UPower manager", () => this._disconnectManager());
    }
};
