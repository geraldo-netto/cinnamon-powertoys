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

var PowerProfilesClient = class PowerProfilesClient {
    constructor(onChanged) {
        this._onChanged = onChanged || function () {};
        this._proxy = null;
        this._propSignalId = 0;
        this._watchIds = [];
        this.busName = null;

        this._connect();

        for (let backend of BACKENDS) {
            this._watchIds.push(Gio.bus_watch_name(
                Gio.BusType.SYSTEM, backend.name, Gio.BusNameWatcherFlags.NONE,
                () => {
                    if (!this._proxy) {
                        this._connect();
                        this._onChanged();
                    }
                },
                () => {
                    if (this.busName === backend.name) {
                        this._disconnectProxy();
                        this._onChanged();
                    }
                }));
        }
    }

    _connect() {
        for (let backend of BACKENDS) {
            try {
                let wrapper = Gio.DBusProxy.makeProxyWrapper(_interfaceXml(backend.name));
                let proxy = new wrapper(Gio.DBus.system, backend.name, backend.path);
                if (!proxy.Profiles || proxy.Profiles.length === 0)
                    continue;
                this._proxy = proxy;
                this.busName = backend.name;
                this._propSignalId = proxy.connect("g-properties-changed", () => this._onChanged());
                return;
            } catch (e) {
                /* daemon not running under this name */
            }
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
    }

    get available() {
        return this._proxy !== null;
    }

    get version() {
        return this._proxy ? this._proxy.Version : null;
    }

    /* Profile names, in daemon order (power-saver first). */
    get profiles() {
        if (!this._proxy || !this._proxy.Profiles)
            return [];
        return this._proxy.Profiles.map(entry => {
            let value = entry.Profile;
            return (value && typeof value.unpack === "function") ? value.unpack() : value;
        }).filter(name => typeof name === "string");
    }

    get profileDetails() {
        if (!this._proxy || !this._proxy.Profiles)
            return [];
        return this._proxy.Profiles.map(_unpackVariantDict);
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

    /* Applications currently forcing a profile, e.g. a game or a video call. */
    get holds() {
        if (!this._proxy || !this._proxy.ActiveProfileHolds)
            return [];
        return this._proxy.ActiveProfileHolds.map(_unpackVariantDict).map(hold => ({
            application: hold.ApplicationId || "",
            profile: hold.Profile || "",
            reason: hold.Reason || "",
        }));
    }

    setProfile(name) {
        if (!this._proxy)
            return false;
        try {
            this._proxy.ActiveProfile = name;
            return true;
        } catch (e) {
            global.logError("[powertoys] cannot set power profile: " + e);
            return false;
        }
    }

    /* Next profile in PROFILE_ORDER, skipping any the daemon does not offer. */
    nextProfile() {
        let profiles = this.profiles;
        if (profiles.length === 0)
            return null;
        let ordered = PROFILE_ORDER.filter(name => profiles.indexOf(name) >= 0);
        for (let name of profiles) {
            if (ordered.indexOf(name) < 0)
                ordered.push(name);
        }
        let index = ordered.indexOf(this.active);
        return ordered[(index + 1) % ordered.length];
    }

    destroy() {
        this._disconnectProxy();
        for (let id of this._watchIds) {
            try {
                Gio.bus_unwatch_name(id);
            } catch (e) {
                /* already gone */
            }
        }
        this._watchIds = [];
    }
};
