/*
 * cinnamon-powertoys - power profile backends.
 *
 * Preferred backend is power-profiles-daemon, which exports the same interface
 * under two names depending on its version (net.hadess.PowerProfiles up to
 * 0.13, org.freedesktop.UPower.PowerProfiles from 0.20). When the daemon is
 * absent the ACPI platform profile is used instead, which needs root and is
 * therefore written through the pkexec helper.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const BACKENDS = [
    { name: "net.hadess.PowerProfiles", path: "/net/hadess/PowerProfiles" },
    { name: "org.freedesktop.UPower.PowerProfiles", path: "/org/freedesktop/UPower/PowerProfiles" },
];

function _interfaceXml(name) {
    return '<node>\
<interface name="' + name + '">\
    <method name="HoldProfile">\
        <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>\
        <arg type="u" direction="out"/>\
    </method>\
    <method name="ReleaseProfile"><arg type="u" direction="in"/></method>\
    <property name="ActiveProfile" type="s" access="readwrite"/>\
    <property name="PerformanceDegraded" type="s" access="read"/>\
    <property name="PerformanceInhibited" type="s" access="read"/>\
    <property name="Profiles" type="aa{sv}" access="read"/>\
    <property name="ActiveProfileHolds" type="aa{sv}" access="read"/>\
    <property name="Actions" type="as" access="read"/>\
    <property name="Version" type="s" access="read"/>\
</interface>\
</node>';
}

/*
 * The profiles in the order stepping runs through them: the wheel, the hotkey
 * and the middle click.
 *
 * It is the backend's own order, and that is the whole rule. Both of them
 * publish their profiles from the least performant to the most - the daemon
 * says so on its interface, and platform_profile_choices is printed from the
 * kernel's own enum, which runs low-power, cool, quiet, balanced,
 * balanced-performance, performance - so the backend has already answered the
 * only question stepping asks, which is which way is up.
 *
 * This used to put three known names first and append everything else, so that
 * stepping "always runs power saver, balanced, performance". On
 * power-profiles-daemon that changes nothing, since those three in that order
 * are exactly what it publishes; it was never tried against anything else. The
 * ACPI platform profile is anything else: a firmware offering
 * `low-power balanced performance` has only two names on the list, so it came
 * out as balanced, performance, low-power. One flick of the wheel upward from
 * balanced reached performance and the next reached the machine's lowest
 * profile, and the segmented control two inches away drew the same three
 * profiles in the order the firmware gave them. One control, two orders.
 *
 * The names with nothing in them are dropped rather than stepped onto, since
 * a profile that cannot be asked for is not a stop on the way to one that can.
 */
function orderedProfiles(list) {
    return (list || []).filter(name => typeof name === "string" && name !== "");
}

/*
 * The profile a step of the wheel, the hotkey or the middle click lands on, or
 * null where it lands where it already was.
 *
 * `from` is the profile being shown rather than the one the machine has got
 * round to - those differ for as long as a change is in flight, which on the
 * firmware path is as long as a password dialog is on screen - and a step that
 * comes to the same name is not a change, so the caller can tell the wheel to
 * do nothing rather than write a profile that is already asked for.
 *
 * The wheel clamps and the hotkey wraps: stopping at performance is what a
 * wheel does at the end of its travel, and coming round again is what a single
 * key that cycles has to do. A `from` that is not on the list at all - the
 * daemon changed its profiles while a change was pending - starts at the
 * beginning rather than nowhere.
 */
function nextProfile(list, from, step, wrap) {
    let ordered = orderedProfiles(list);
    if (ordered.length === 0)
        return null;

    let at = ordered.indexOf(from);
    if (at < 0)
        return ordered[0];

    let target = at + step;
    if (wrap)
        target = ((target % ordered.length) + ordered.length) % ordered.length;
    else
        target = Math.max(0, Math.min(ordered.length - 1, target));

    return ordered[target] === from ? null : ordered[target];
}

/*
 * The profile names a proxy really offers.
 *
 * What makes something a daemon this applet can use is not that it publishes a
 * Profiles property but that there are names in it to put on the menu. The two
 * were asked separately - the search accepted any non-empty array, the menu
 * read the names out of it - so a daemon whose entries carry no name, which is
 * what a version that renamed the key would look like, was connected to and
 * then drew a profile control with nothing in it. There is a fallback for a
 * daemon this applet cannot use, and that is the case it exists for.
 */
function _profileNames(proxy) {
    let entries = proxy ? proxy.Profiles : null;
    if (!entries)
        return [];
    return entries.map(entry => {
        let value = entry.Profile;
        return (value && typeof value.unpack === "function") ? value.unpack() : value;
    }).filter(name => typeof name === "string" && name !== "");
}

function _unpackVariantDict(entry) {
    let result = {};
    for (let key in entry) {
        let value = entry[key];
        result[key] = (value && typeof value.deepUnpack === "function") ? value.deepUnpack() : value;
    }
    return result;
}

/*
 * Everything this client does on the system bus, gathered so that a caller can
 * hand it something else.
 *
 * Every other backend here takes its way out as a parameter - ddc.js a `run`,
 * bluez.js a `call`, privileged.js a `spawn`, cpu.js and power-supply.js a
 * runner and the IO root - which is why each of them has cases that run
 * anywhere. This one reached for the bus in three places, so the only thing
 * that could ever exercise it was a machine with the daemon actually running,
 * and CI has neither.
 *
 * Three calls rather than one, because they are three different moments: the
 * proxy is built once per name, the watches outlive the proxy, and the write
 * is a call in its own right whose reply the caller needs - see setProfile.
 */
function systemBus() {
    return {
        /* Gio invokes exactly one of appeared/vanished with the current state
         * after each watch is installed. This lets the client avoid probing
         * names the bus has already said nobody owns. */
        watchReportsInitialState: true,
        /*
         * Asynchronous, like every other proxy this applet builds.
         *
         * A proxy wrapper called without a callback is the synchronous form:
         * GJS runs init() rather than init_async(), which is a connection and a
         * GetAll round trip on the system bus, taken on the thread that draws
         * the desktop. It happened in the applet's constructor and again every
         * time one of the two names appeared, so a daemon slow to answer - or
         * wedged, with D-Bus waiting out its timeout - was a stalled
         * compositor, and the panel does not come back until it answers.
         *
         * lib/upower.js and lib/backlight.js both hand their proxy a callback,
         * and lib/ddc.js opens by saying that nothing in it is synchronous and
         * nothing blocks the shell. This was the one place that did.
         */
        proxy: function (backend, onDone, cancellable) {
            let wrapper = Gio.DBusProxy.makeProxyWrapper(_interfaceXml(backend.name));
            new wrapper(Gio.DBus.system, backend.name, backend.path,
                        (proxy, error) => onDone(proxy, error), cancellable || null);
        },
        watch: function (name, onAppeared, onVanished) {
            return Gio.bus_watch_name(Gio.BusType.SYSTEM, name,
                                      Gio.BusNameWatcherFlags.NONE, onAppeared, onVanished);
        },
        unwatch: function (id) {
            Gio.bus_unwatch_name(id);
        },
        cancellable: function () {
            return new Gio.Cancellable();
        },
        setProperty: function (name, path, property, value, cancellable, onDone) {
            /* Keep the direct helper useful to callers that do not need
             * cancellation, including older integrations. */
            if (typeof cancellable === "function") {
                onDone = cancellable;
                cancellable = null;
            }
            let target = new GLib.Variant("(ssv)",
                                          [name, property, new GLib.Variant("s", value)]);
            Gio.DBus.system.call(name, path, "org.freedesktop.DBus.Properties", "Set", target,
                                 null, Gio.DBusCallFlags.NONE, -1, cancellable,
                                 (connection, result) => {
                                     try {
                                         connection.call_finish(result);
                                         onDone(null);
                                     } catch (error) {
                                         onDone(error);
                                     }
                                 });
        },
    };
}

var PowerProfilesClient = class PowerProfilesClient {
    constructor(onChanged, bus) {
        this._onChanged = onChanged || function () {};
        this._bus = bus || systemBus();
        this._proxy = null;
        this._propSignalId = 0;
        this._watchIds = [];
        this._ownerAware = this._bus.watchReportsInitialState === true;
        this._ownerStates = BACKENDS.map(() => null);
        this._setCall = null;
        this._setQueued = null;
        this.busName = null;
        this.busPath = null;
        this.destroyed = false;
        /* A search for the daemon is under way; see _connect. */
        this._connecting = false;
        this._connectPending = false;
        this._connectCall = null;
        /* Built on demand and dropped whenever the daemon says anything has
         * changed - see snapshot(). */
        this._snapshot = null;

        for (let index = 0; index < BACKENDS.length; index++) {
            let backend = BACKENDS[index];
            try {
                let id = this._bus.watch(
                    backend.name,
                    () => this._ownerChanged(index, true),
                    () => this._ownerChanged(index, false));
                if (id)
                    this._watchIds.push(id);
            } catch (e) {
                /* One unavailable watcher must not discard an earlier one or
                 * prevent the current daemon from being used. The initial
                 * search below still supplies a complete present-time state. */
                if (this._ownerAware)
                    this._ownerStates[index] = false;
            }
        }

        /* Install every viable edge listener before taking the initial state,
         * so a daemon cannot change in the gap between discovery and watches.
         * A production watch supplies that state itself; injected buses which
         * do not promise it retain the legacy probing fallback. */
        this._connect();
    }

    _ownerChanged(index, present) {
        if (this.destroyed)
            return;
        if (this._ownerAware)
            this._ownerStates[index] = present;

        let backend = BACKENDS[index];
        if (!present && this.busName === backend.name) {
            this._disconnectProxy(new Error("power-profiles-daemon stopped"));
            this._invalidate();
        }

        if (this._ownerAware && this._ownerStates.every(state => state !== null)) {
            let wanted = this._ownedBackends()[0] || null;
            /* A newly available higher-priority name replaces the fallback;
             * an in-flight search for a name no longer selected is obsolete. */
            if (this._proxy && (!wanted || this.busName !== wanted.name)) {
                this._disconnectProxy(new Error("power profile backend changed"));
                this._invalidate();
            }
            if (this._connectCall &&
                (!wanted || this._connectCall.backend.name !== wanted.name))
                this._cancelConnect();
        }
        this._connect();
    }

    _ownedBackends() {
        if (!this._ownerAware)
            return BACKENDS;
        let result = [];
        for (let index = 0; index < BACKENDS.length; index++) {
            if (this._ownerStates[index] === true)
                result.push(BACKENDS[index]);
        }
        return result;
    }

    /*
     * Looks for the daemon under each name in turn and stops at the first that
     * offers profiles.
     *
     * The answer arrives rather than being returned, so `available` is false
     * until the bus has spoken and the caller finds out through onChanged -
     * which is the same way it hears about the daemon being started later, and
     * why the applet chooses its profile backend on every change rather than
     * once at startup.
     */
    _connect() {
        if (this.destroyed || this._proxy)
            return;
        if (this._ownerAware && this._ownerStates.some(state => state === null))
            return;
        if (this._connecting) {
            /* Name watches are edges, not a state that will be repeated. If
             * one fires while another backend is being tried, remember it so
             * a failed search cannot consume the only wake-up. */
            this._connectPending = true;
            return;
        }
        this._connectPending = false;
        this._connecting = true;
        this._tryBackend(0, this._ownedBackends());
    }

    _finishConnectSearch() {
        this._connecting = false;
        if (this._connectPending) {
            this._connectPending = false;
            this._connect();
        }
    }

    _tryBackend(index, candidates) {
        if (index >= candidates.length) {
            this._finishConnectSearch();
            return;
        }

        let backend = candidates[index];
        let next = () => this._tryBackend(index + 1, candidates);
        let cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        let operation = { backend: backend, cancellable: cancellable };
        this._connectCall = operation;

        try {
            this._bus.proxy(backend, (proxy, error) => {
                if (this._connectCall !== operation)
                    return;
                this._connectCall = null;
                if (this.destroyed) {
                    this._connecting = false;
                    this._connectPending = false;
                    return;
                }
                /*
                 * Nobody owns the name, or something owns it and has nothing
                 * on it. Neither is a daemon this applet can use, and neither
                 * is a reason to stop looking at the other name.
                 */
                if (error || !proxy || _profileNames(proxy).length === 0) {
                    next();
                    return;
                }

                this._connecting = false;
                this._connectPending = false;
                this._proxy = proxy;
                this.busName = backend.name;
                this.busPath = backend.path;
                this._propSignalId = proxy.connect("g-properties-changed",
                                                   () => this._invalidate());
                this._invalidate();
            }, cancellable);
        } catch (e) {
            if (this._connectCall !== operation)
                return;
            this._connectCall = null;
            /* daemon not running under this name */
            next();
        }
    }

    _cancelConnect() {
        let operation = this._connectCall;
        this._connectCall = null;
        this._connecting = false;
        this._connectPending = false;
        if (operation && operation.cancellable) {
            try {
                operation.cancellable.cancel();
            } catch (e) {
                /* already cancelled */
            }
        }
    }

    _disconnectProxy(writeError) {
        this._cancelProfileWrites(writeError, !!writeError);
        if (this._proxy && this._propSignalId) {
            try {
                this._proxy.disconnect(this._propSignalId);
            } catch (e) {
                /* already gone */
            }
        }
        this._proxy = null;
        this._propSignalId = 0;
        this.busName = null;
        this.busPath = null;
        this._snapshot = null;
    }

    _cancelProfileWrites(error, notify) {
        let current = this._setCall;
        let queued = this._setQueued;
        this._setCall = null;
        this._setQueued = null;
        if (current && current.cancellable) {
            try {
                current.cancellable.cancel();
            } catch (e) {
                /* already cancelled */
            }
        }
        if (notify) {
            if (current)
                current.done(error);
            if (queued)
                queued.done(error);
        }
    }

    /* The daemon has spoken, so what was worked out from it is stale. */
    _invalidate() {
        this._snapshot = null;
        this._onChanged();
    }

    /*
     * Everything a reading asks about the profile, worked out once.
     *
     * The getters below each unpack their own variants, and a poll wanted six
     * of them - the profile list and the holds are arrays of dictionaries, and
     * unpacking those was the largest single cost in a collection. None of it
     * can change without the daemon saying so on g-properties-changed, and
     * that is already listened to, so the answer is kept until it does.
     */
    snapshot() {
        if (!this._snapshot) {
            this._snapshot = {
                available: this.available,
                busName: this.busName,
                active: this.active,
                profiles: this.profiles,
                degraded: this.degraded,
                holds: this.holds,
            };
        }
        return this._snapshot;
    }

    get available() {
        return this._proxy !== null;
    }

    get version() {
        return this._proxy ? this._proxy.Version : null;
    }

    /*
     * Profile names, in daemon order (power-saver first).
     *
     * The property is read into a local first. Reading it twice - once to ask
     * whether it is there and once to walk it - is two unpacks of an array of
     * dictionaries, which is the cost snapshot() exists to keep down.
     */
    get profiles() {
        return _profileNames(this._proxy);
    }

    /* A name or nothing, the way `degraded` is a reason or an empty string: a
     * proxy built before the daemon has published its properties carries none
     * of them, and undefined is not a profile name - it is a value's insides,
     * and it reaches the menu. */
    get active() {
        return (this._proxy && this._proxy.ActiveProfile) || null;
    }

    /* Non-empty when the firmware is throttling, e.g. "lap-detected". */
    get degraded() {
        if (!this._proxy)
            return "";
        return this._proxy.PerformanceDegraded || this._proxy.PerformanceInhibited || "";
    }

    /* Applications currently forcing a profile, e.g. a game or a video call.
     * Read into a local for the reason given above profiles(). */
    get holds() {
        let entries = this._proxy ? this._proxy.ActiveProfileHolds : null;
        if (!entries)
            return [];
        return entries.map(_unpackVariantDict).map(hold => ({
            application: hold.ApplicationId || "",
            profile: hold.Profile || "",
            reason: hold.Reason || "",
        }));
    }

    /*
     * The property setter the proxy wrapper generates fires the Set call and
     * forgets about it, so a refusal - polkit says no, the daemon does not
     * know the profile, it went away between the click and the call - never
     * reaches the caller and the menu silently keeps its old selection.
     * Issuing Set here keeps hold of the reply. onResult is called with null
     * when the daemon accepted the change, and with the error when it did not.
     */
    setProfile(name, onResult) {
        let done = onResult || function () {};
        if (!this._proxy) {
            done(new Error("power-profiles-daemon is not available"));
            return false;
        }

        let operation = { name: name, done: this._once(done), cancellable: null };
        if (this._setCall) {
            if (this._setQueued)
                this._setQueued.done(new Error("profile request was superseded"));
            this._setQueued = operation;
            return true;
        }
        this._setQueued = operation;
        return this._drainProfileWrites();
    }

    _once(callback) {
        let called = false;
        return error => {
            if (called)
                return;
            called = true;
            callback(error);
        };
    }

    _drainProfileWrites() {
        if (this.destroyed || this._setCall || !this._setQueued)
            return false;

        let call = this._setQueued;
        this._setQueued = null;
        if (!this._proxy) {
            call.done(new Error("power-profiles-daemon is not available"));
            return false;
        }

        call.cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        this._setCall = call;
        let busName = this.busName;
        let busPath = this.busPath;
        let finish = error => {
            if (this._setCall !== call)
                return;
            this._setCall = null;
            if (!this.destroyed)
                call.done(error);
            this._drainProfileWrites();
        };
        try {
            this._bus.setProperty(busName, busPath, "ActiveProfile", call.name,
                                  call.cancellable, finish);
        } catch (error) {
            this._setCall = null;
            call.done(error);
            this._drainProfileWrites();
            return false;
        }
        return true;
    }

    /* Stepping through profiles lives in the applet, which also has to handle
     * the ACPI platform profile fallback; orderedProfiles above is the shared
     * part. */

    destroy() {
        /* A search may still be out on the bus; what it finds is no longer
         * wanted, the same way a probe in flight is disowned in lib/ddc.js. */
        this.destroyed = true;
        this._connectPending = false;
        this._cancelConnect();
        this._cancelProfileWrites(null, false);
        this._disconnectProxy();
        for (let id of this._watchIds) {
            try {
                this._bus.unwatch(id);
            } catch (e) {
                /* already gone */
            }
        }
        this._watchIds = [];
    }
};
