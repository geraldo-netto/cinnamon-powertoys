/*
 * The three D-Bus calls this applet actually makes, said once.
 *
 * Four modules talk to a daemon by name - UPower, power-profiles-daemon,
 * BlueZ, and the settings daemon that owns the kernel backlight - and each of
 * them wrote out the same three things: watch a name and keep the id, give the
 * id back to stop watching, and build a cancellable where the runtime has one.
 * They differed only in which bus, which watcher flags, and whether the
 * cancellable failure was tolerated, which is exactly the kind of difference
 * nobody intends.
 *
 * Every function here takes the same optional `gio`, because that injection is
 * the reason the four ports exist: a case substitutes a bus that refuses to
 * watch, or a runtime with no cancellable in it, without a session anywhere.
 */

const Gio = imports.gi.Gio;

function _adapter(gio) {
    return gio || Gio;
}

/*
 * One name watch. Answers whatever the bus answered, which is the id `release`
 * needs; a bus that answers nothing has not installed a watch, and the caller
 * is the one that knows what to do about that.
 *
 * `options.session` picks the session bus over the system one, and
 * `options.autoStart` asks the bus to start the daemon rather than only report
 * on it - which is UPower, where the applet wants the service running and the
 * others, where it does not.
 */
function watch(name, onAppeared, onVanished, options) {
    options = options || {};
    let gio = _adapter(options.gio);
    /* The call is the adapter's, the two enumerations are not: an injected bus
     * substitutes behaviour, and several of them are a bare object with one
     * method on it. Reading the constants off the adapter asked those stubs to
     * carry a copy of GLib's enumerations to be usable at all. */
    let names = gio.BusType ? gio : Gio;
    return gio.bus_watch_name(
        options.session ? names.BusType.SESSION : names.BusType.SYSTEM, name,
        options.autoStart ? names.BusNameWatcherFlags.AUTO_START
                          : names.BusNameWatcherFlags.NONE,
        onAppeared, onVanished);
}

/* The other half of a watch. */
function release(id, gio) {
    _adapter(gio).bus_unwatch_name(id);
}

/*
 * A cancellable, or null where there is none to be had.
 *
 * Cancellation is an optimisation here and not correctness: every caller that
 * uses one also carries a generation guard, because a cancelled call may still
 * arrive. So an injected runtime without cancellables is answered with null
 * rather than with a throw, which is what two of the four callers had each
 * decided for themselves.
 */
function cancellable(gio) {
    try {
        return new (_adapter(gio).Cancellable)();
    } catch (error) {
        return null;
    }
}

/* A proxy class from its interface description. */
function wrapperFor(xml, gio) {
    return _adapter(gio).DBusProxy.makeProxyWrapper(xml);
}

/*
 * A proxy, asynchronously.
 *
 * Asynchronously is the whole point: a proxy wrapper called without a callback
 * is the synchronous form, which is a connection and a GetAll round trip taken
 * on the thread that draws the desktop, and a daemon slow to answer is a
 * stalled compositor.
 */
function proxy(wrapper, name, path, onDone, options) {
    options = options || {};
    let gio = _adapter(options.gio);
    let buses = gio.DBus ? gio : Gio;
    return new wrapper(options.session ? buses.DBus.session : buses.DBus.system,
                       name, path, (built, error) => onDone(built, error),
                       options.cancellable || null);
}

/*
 * What came back off a proxy, without the variant around it.
 *
 * A GVariant property read off a proxy is sometimes already the value and
 * sometimes the box - which of the two depends on the interface, on the
 * wrapper, and on the runtime a case substitutes - so every caller ends up
 * asking the same question of it. Three of them asked it separately: BlueZ of
 * a device's properties, and power-profiles-daemon twice, once for a name and
 * once for a whole dictionary.
 *
 * `unpack` is the shallow form, for a value that is one scalar in a box.
 */
function unpack(value) {
    return value && typeof value.unpack === "function" ? value.unpack() : value;
}

/* And the recursive one, for a value that may hold others. */
function deepUnpack(value) {
    return value && typeof value.deepUnpack === "function" ? value.deepUnpack() : value;
}

/* One dictionary of them: every value unpacked, the keys left alone. */
function unpackDict(entry) {
    let result = {};
    for (let key in entry)
        result[key] = deepUnpack(entry[key]);
    return result;
}
