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

const Bus = require("./lib/bus.js");
const Log = require("./lib/log.js");
const Once = require("./lib/once.js");
const OwnerWatch = require("./lib/owner-watch.js");
const Backoff = require("./lib/backoff.js");

const BACKENDS = [
    { name: "net.hadess.PowerProfiles", path: "/net/hadess/PowerProfiles" },
    { name: "org.freedesktop.UPower.PowerProfiles", path: "/org/freedesktop/UPower/PowerProfiles" },
];

/* A watcher setup failure means ownership is unknown, not absent. Keep it
 * distinct from both the pending initial edge (null) and confirmed absence
 * (false), so direct discovery can cover the missing observation. */
const OWNER_WATCH_FAILED = "watch-failed";

/* A queued write that is replaced by a newer choice was not refused and did
 * not reach the daemon. Keep that normal coalescing outcome out of Error so a
 * caller can settle its state without presenting a failure to the user. */
const PROFILE_SUPERSEDED = Object.freeze({ status: "superseded" });

function isProfileSuperseded(outcome) {
    return outcome === PROFILE_SUPERSEDED;
}

/* The transport still reports null or an Error. The queue adds the one
 * non-error outcome above; this boundary keeps presentation code from having
 * to mistake a deliberately discarded intermediate choice for a failure. */
function profileWriteError(outcome) {
    return isProfileSuperseded(outcome) ? null : (outcome || null);
}

function _interfaceXml(name) {
    return '<node>' +
        '<interface name="' + name + '">' +
            '<method name="HoldProfile">' +
                '<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>' +
                '<arg type="u" direction="out"/>' +
            '</method>' +
            '<method name="ReleaseProfile"><arg type="u" direction="in"/></method>' +
            '<property name="ActiveProfile" type="s" access="readwrite"/>' +
            '<property name="PerformanceDegraded" type="s" access="read"/>' +
            '<property name="PerformanceInhibited" type="s" access="read"/>' +
            '<property name="Profiles" type="aa{sv}" access="read"/>' +
            '<property name="ActiveProfileHolds" type="aa{sv}" access="read"/>' +
            '<property name="Actions" type="as" access="read"/>' +
            '<property name="Version" type="s" access="read"/>' +
        '</interface>' +
        '</node>';
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
    return entries.map(entry => Bus.unpack(entry.Profile))
        .filter(name => typeof name === "string" && name !== "");
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
 * `gio` is replaceable so this adapter can be checked without a live bus.
 */
function systemBus(gio) {
    gio = gio || Gio;
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
            return Bus.proxy(Bus.wrapperFor(_interfaceXml(backend.name), gio),
                             backend.name, backend.path, onDone,
                             { gio: gio, cancellable: cancellable });
        },
        watch: function (name, onAppeared, onVanished) {
            return Bus.watch(name, onAppeared, onVanished, { gio: gio });
        },
        unwatch: function (id) {
            Bus.release(id, gio);
        },
        cancellable: function () {
            return Bus.cancellable(gio);
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
            gio.DBus.system.call(name, path, "org.freedesktop.DBus.Properties", "Set", target,
                                 null, gio.DBusCallFlags.NONE, -1, cancellable,
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

/*
 * Which power-profiles daemon this applet is talking to, and staying talked to.
 *
 * Two bus names publish the same interface, one per daemon generation, and
 * either may appear or vanish while Cinnamon is running. Everything that
 * follows from that - a name watch per backend, the priority order between
 * them, building and tearing down the proxy, the capped-doubling retry when
 * no candidate answered, and the failure log that keeps one owned backend's
 * repeated refusals to one line - is this object and nothing else. What is
 * read off the proxy, and what is written to it, are somebody else's.
 *
 * `onChanged` says the connection or the daemon's properties moved. `onDropped`
 * says the proxy has gone, with the error a pending write should be refused
 * with, or null when nothing needs answering.
 */
const ProfileBackendConnection = class ProfileBackendConnection {
    constructor(bus, options) {
        let configuration = options || {};
        this.bus = bus;
        this._onChanged = configuration.onChanged || function () {};
        this._onDropped = configuration.onDropped || function () {};
        this._bus = bus;
        this.proxy = null;
        this.busName = null;
        this.busPath = null;
        this.destroyed = false;
        this._propSignalId = 0;
        this._ownerWatches = [];
        this._ownerAware = this._bus.watchReportsInitialState === true;
        this._ownerStates = BACKENDS.map(() => null);
        /* A search for the daemon is under way; see _connect. */
        this._connecting = false;
        this._connectPending = false;
        this._connectCall = null;
        this._retry = new Backoff.Backoff({
            timers: this._bus,
            initialMs: Backoff.BUS_INITIAL_MS,
            maxMs: Backoff.BUS_MAX_MS,
            allow: () => !this.destroyed && this._ownerAware &&
                this._ownedBackends().length > 0,
            run: () => this._connect(),
        });
        this.failures = new Log.FailureLog();
    }

    /* The backend a write should be addressed to, or null while there is
     * none. */
    target() {
        return this.proxy ? { name: this.busName, path: this.busPath } : null;
    }

    start() {
        for (let index = 0; index < BACKENDS.length; index++) {
            let backend = BACKENDS[index];
            let watcher = OwnerWatch.watchOwnership({
                install: (appeared, vanished) =>
                    this._bus.watch(backend.name, appeared, vanished),
                release: id => this._bus.unwatch(id),
                appeared: () => this._ownerChanged(index, true),
                vanished: () => this._ownerChanged(index, false),
                onInstalled: reported => {
                    if (this._ownerAware && !reported)
                        this._ownerStates[index] = null;
                },
                onFailed: () => {
                    /* Unknown ownership stays probeable while this missing
                     * edge is being restored. */
                    if (this._ownerAware)
                        this._ownerStates[index] = OWNER_WATCH_FAILED;
                },
                failures: this.failures,
                failureKey: "owner-watch:" + backend.name,
                failureMessage: "cannot watch " + backend.name + " ownership",
                timers: this._bus,
            });
            this._ownerWatches.push(watcher);
            watcher.start();
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
        this._cancelRetry();

        let backend = BACKENDS[index];
        if (!present)
            this.failures.recover("backend:" + backend.name);
        if (!present && this.busName === backend.name) {
            this._disconnectProxy(new Error("power-profiles-daemon stopped"));
            this._onChanged();
        }

        if (this._ownerAware && this._ownerStates.every(state => state !== null)) {
            let wanted = this._ownedBackends()[0] || null;
            /* A newly available higher-priority name replaces the fallback;
             * an in-flight search for a name no longer selected is obsolete. */
            if (this.proxy && (!wanted || this.busName !== wanted.name)) {
                this._disconnectProxy(new Error("power profile backend changed"));
                this._onChanged();
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
            if (this._ownerStates[index] === true ||
                this._ownerStates[index] === OWNER_WATCH_FAILED)
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
        if (this.destroyed || this.proxy)
            return;
        if (this._ownerAware && this._ownerStates.includes(null))
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

    _finishConnectSearch(failed) {
        this._connecting = false;
        if (this._connectPending) {
            this._connectPending = false;
            this._connect();
            return;
        }
        if (failed)
            this._retry.schedule();
    }

    _backendIsOwned(backend) {
        if (!this._ownerAware)
            return false;
        let index = BACKENDS.indexOf(backend);
        return index >= 0 && this._ownerStates[index] === true;
    }

    _reportBackendFailure(backend, reason) {
        if (!this._backendIsOwned(backend))
            return;
        this.failures.report(
            "backend:" + backend.name,
            "cannot use owned power profile backend " + backend.name + ": " + reason);
    }

    _tryBackend(index, candidates) {
        if (index >= candidates.length) {
            this._finishConnectSearch(candidates.length > 0);
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
                /* An absent or unusable candidate is not a reason to stop
                 * looking at the other name. Only a watcher-confirmed owner
                 * makes that failed candidate a diagnostic incident. */
                let reason = error;
                let names = [];
                if (!reason && !proxy)
                    reason = new Error("proxy construction returned no proxy");
                if (!reason) {
                    try {
                        names = _profileNames(proxy);
                    } catch (profileError) {
                        reason = profileError;
                    }
                }
                if (!reason && names.length === 0)
                    reason = new Error("daemon reported no usable profiles");
                if (reason) {
                    this._reportBackendFailure(backend, reason);
                    next();
                    return;
                }

                let signalId = 0;
                try {
                    signalId = proxy.connect("g-properties-changed",
                                             () => this._onChanged());
                } catch (e) {
                    this._reportBackendFailure(
                        backend, "property change subscription failed: " + e);
                    next();
                    return;
                }
                if (!signalId) {
                    this._reportBackendFailure(
                        backend, "property change subscription returned no id");
                    next();
                    return;
                }

                this.failures.recover("backend:" + backend.name);
                this._connecting = false;
                this._connectPending = false;
                this._cancelRetry();
                this.proxy = proxy;
                this.busName = backend.name;
                this.busPath = backend.path;
                this._propSignalId = signalId;
                this._onChanged();
            }, cancellable);
        } catch (e) {
            if (this._connectCall !== operation)
                return;
            this._connectCall = null;
            this._reportBackendFailure(backend, e);
            next();
        }
    }

    _cancelConnect() {
        let operation = this._connectCall;
        this._connectCall = null;
        this._connecting = false;
        this._connectPending = false;
        if (operation?.cancellable) {
            try {
                operation.cancellable.cancel();
            } catch (e) {
                /* already cancelled */
            }
        }
    }

    _cancelRetry() {
        this._retry.cancel();
    }

    _disconnectProxy(writeError) {
        this._onDropped(writeError || null);
        if (this.proxy && this._propSignalId) {
            try {
                this.proxy.disconnect(this._propSignalId);
            } catch (e) {
                /* already gone */
            }
        }
        this.proxy = null;
        this._propSignalId = 0;
        this.busName = null;
        this.busPath = null;
    }

    destroy() {
        /* A search may still be out on the bus; what it finds is no longer
         * wanted, the same way a probe in flight is disowned in lib/ddc.js. */
        this.destroyed = true;
        this._connectPending = false;
        /* The bus name watches are behind the proxy, and a proxy that will
         * not disconnect must not leave them watching for a backend that has
         * gone. */
        Log.release("the profile retry", () => this._cancelRetry());
        Log.release("the profile connection attempt", () => this._cancelConnect());
        Log.release("the profile proxy", () => this._disconnectProxy(null));
        let watches = this._ownerWatches;
        this._ownerWatches = [];
        for (let watcher of watches)
            Log.release("a profile owner watch", () => watcher.stop());
    }
};

/*
 * One profile write on the bus at a time, with the newest choice winning.
 *
 * The property setter the proxy wrapper generates fires the Set call and
 * forgets about it, so a refusal - polkit says no, the daemon does not know
 * the profile, it went away between the click and the call - never reaches
 * the caller and the menu silently keeps its old selection. Issuing Set here
 * keeps hold of the reply.
 *
 * A second choice made while the first is still out does not queue behind it
 * indefinitely: one write is in flight, exactly one is waiting, and a third
 * replaces the waiting one, which is told it was superseded rather than
 * refused. Turning the wheel through five profiles is then two calls.
 */
const ProfileWriteQueue = class ProfileWriteQueue {
    /* `target` answers { name, path } for the backend a write goes to, or
     * null while there is nothing to write to. */
    constructor(bus, target) {
        this._bus = bus;
        this._target = target;
        this._current = null;
        this._queued = null;
        this._destroyed = false;
    }

    /*
     * onResult is called with null when the daemon accepted the change, with
     * an Error when it did not, and with PROFILE_SUPERSEDED when a newer
     * queued choice replaced this one. Answers whether the write was taken on.
     */
    write(name, onResult) {
        let done = onResult || function () {};
        if (this._destroyed || !this._target()) {
            done(new Error("power-profiles-daemon is not available"));
            return false;
        }

        let operation = { name: name, done: Once.once(done), cancellable: null };
        if (this._current) {
            if (this._queued)
                this._queued.done(PROFILE_SUPERSEDED);
            this._queued = operation;
            return true;
        }
        this._queued = operation;
        return this._drain();
    }

    _drain() {
        if (this._destroyed || this._current || !this._queued)
            return false;

        let call = this._queued;
        this._queued = null;
        let target = this._target();
        if (!target) {
            call.done(new Error("power-profiles-daemon is not available"));
            return false;
        }

        call.cancellable = this._bus.cancellable ? this._bus.cancellable() : null;
        this._current = call;
        let finish = error => {
            if (this._current !== call)
                return;
            this._current = null;
            if (!this._destroyed)
                call.done(error);
            this._drain();
        };
        try {
            this._bus.setProperty(target.name, target.path, "ActiveProfile", call.name,
                                  call.cancellable, finish);
        } catch (error) {
            this._current = null;
            call.done(error);
            this._drain();
            return false;
        }
        return true;
    }

    /* Drops the write in flight and the one waiting. With `notify`, each is
     * answered with `error` rather than left waiting for a reply that the
     * cancelled call will never bring. */
    cancel(error, notify) {
        let current = this._current;
        let queued = this._queued;
        this._current = null;
        this._queued = null;
        if (current?.cancellable) {
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

    destroy() {
        this._destroyed = true;
        this.cancel(null, false);
    }
};

/*
 * The power profile backend the rest of the applet holds.
 *
 * Two objects underneath: one that keeps a connection to whichever daemon is
 * on the bus, and one that writes profiles to it. What is left here is what a
 * reading needs - the six properties, unpacked once per change and kept until
 * the daemon says something moved.
 */
const PowerProfilesClient = class PowerProfilesClient {
    constructor(onChanged, bus) {
        this._onChanged = onChanged || function () {};
        this.destroyed = false;
        /* Built on demand and dropped whenever the daemon says anything has
         * changed - see snapshot(). */
        this._snapshot = null;

        this._connection = new ProfileBackendConnection(bus || systemBus(), {
            onChanged: () => this._invalidate(),
            /* The proxy is going away, so a Set already out on it will never
             * be answered by the daemon. */
            onDropped: error => {
                this._snapshot = null;
                this._writes.cancel(error, !!error);
            },
        });
        this._writes = new ProfileWriteQueue(this._connection.bus,
                                             () => this._connection.target());
        this._connection.start();
    }

    get busName() {
        return this._connection.busName;
    }

    get busPath() {
        return this._connection.busPath;
    }

    get _proxy() {
        return this._connection.proxy;
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
        return this._proxy?.ActiveProfile || null;
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
        return entries.map(Bus.unpackDict).map(hold => ({
            application: hold.ApplicationId || "",
            profile: hold.Profile || "",
            reason: hold.Reason || "",
        }));
    }

    /* See ProfileWriteQueue.write for what onResult is told. */
    setProfile(name, onResult) {
        return this._writes.write(name, onResult);
    }

    /* Stepping through profiles lives in the applet, which also has to handle
     * the ACPI platform profile fallback; orderedProfiles above is the shared
     * part. */

    destroy() {
        this.destroyed = true;
        /* The whole D-Bus connection is behind the write queue. */
        Log.release("the profile writes", () => this._writes.destroy());
        Log.release("the profile connection", () => this._connection.destroy());
    }
};
