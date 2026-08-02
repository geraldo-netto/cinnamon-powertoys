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

/* Order is meaningful: it is the order used when cycling profiles. */
var PROFILE_ORDER = ["power-saver", "balanced", "performance"];

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
        proxy: function (backend, onDone) {
            let wrapper = Gio.DBusProxy.makeProxyWrapper(_interfaceXml(backend.name));
            new wrapper(Gio.DBus.system, backend.name, backend.path,
                        (proxy, error) => onDone(proxy, error));
        },
        watch: function (name, onAppeared, onVanished) {
            return Gio.bus_watch_name(Gio.BusType.SYSTEM, name,
                                      Gio.BusNameWatcherFlags.NONE, onAppeared, onVanished);
        },
        unwatch: function (id) {
            Gio.bus_unwatch_name(id);
        },
        setProperty: function (name, path, property, value, onDone) {
            let target = new GLib.Variant("(ssv)",
                                          [name, property, new GLib.Variant("s", value)]);
            Gio.DBus.system.call(name, path, "org.freedesktop.DBus.Properties", "Set", target,
                                 null, Gio.DBusCallFlags.NONE, -1, null,
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
        this.busName = null;
        this.busPath = null;
        this.destroyed = false;
        /* A search for the daemon is under way; see _connect. */
        this._connecting = false;
        /* Built on demand and dropped whenever the daemon says anything has
         * changed - see snapshot(). */
        this._snapshot = null;

        this._connect();

        for (let backend of BACKENDS) {
            this._watchIds.push(this._bus.watch(
                backend.name,
                /* Connecting says so itself when it finds something, and a
                 * name appearing that turns out to offer no profiles has
                 * changed nothing worth redrawing. */
                () => this._connect(),
                () => {
                    if (this.busName === backend.name) {
                        this._disconnectProxy();
                        this._invalidate();
                    }
                }));
        }
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
        if (this.destroyed || this._proxy || this._connecting)
            return;
        this._connecting = true;
        this._tryBackend(0);
    }

    _tryBackend(index) {
        if (index >= BACKENDS.length) {
            this._connecting = false;
            return;
        }

        let backend = BACKENDS[index];
        let next = () => this._tryBackend(index + 1);

        try {
            this._bus.proxy(backend, (proxy, error) => {
                if (this.destroyed) {
                    this._connecting = false;
                    return;
                }
                /*
                 * Nobody owns the name, or something owns it and has nothing
                 * on it. Neither is a daemon this applet can use, and neither
                 * is a reason to stop looking at the other name.
                 */
                if (error || !proxy || !proxy.Profiles || proxy.Profiles.length === 0) {
                    next();
                    return;
                }

                this._connecting = false;
                this._proxy = proxy;
                this.busName = backend.name;
                this.busPath = backend.path;
                this._propSignalId = proxy.connect("g-properties-changed",
                                                   () => this._invalidate());
                this._invalidate();
            });
        } catch (e) {
            /* daemon not running under this name */
            next();
        }
    }

    _disconnectProxy() {
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
        let entries = this._proxy ? this._proxy.Profiles : null;
        if (!entries)
            return [];
        return entries.map(entry => {
            let value = entry.Profile;
            return (value && typeof value.unpack === "function") ? value.unpack() : value;
        }).filter(name => typeof name === "string");
    }

    get active() {
        return this._proxy ? this._proxy.ActiveProfile : null;
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

        this._bus.setProperty(this.busName, this.busPath, "ActiveProfile", name, done);
        return true;
    }

    /* Stepping through profiles lives in the applet, which also has to handle
     * the ACPI platform profile fallback; PROFILE_ORDER above is the shared
     * part. */

    destroy() {
        /* A search may still be out on the bus; what it finds is no longer
         * wanted, the same way a probe in flight is disowned in lib/ddc.js. */
        this.destroyed = true;
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
