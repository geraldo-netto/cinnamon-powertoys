/*
 * The three D-Bus calls this applet makes, and the two ways an injected bus
 * differs from the real one.
 *
 * Four modules used to write these out for themselves, so the difference
 * between a system watch and a session one, or between a runtime with
 * cancellables and one without, was four separate decisions.
 */

const Harness = imports.harness;

const Bus = Harness.requireXlet("./lib/bus.js");

function adapter() {
    let calls = { watched: [], unwatched: [] };
    calls.gio = {
        BusType: { SYSTEM: "system", SESSION: "session" },
        BusNameWatcherFlags: { NONE: "none", AUTO_START: "auto" },
        DBus: { system: "system connection", session: "session connection" },
        Cancellable: function () { this.kind = "token"; },
        bus_watch_name: function (type, name, flags, appeared, vanished) {
            calls.watched.push([type, name, flags, appeared, vanished]);
            return calls.watched.length;
        },
        bus_unwatch_name: id => calls.unwatched.push(id),
    };
    return calls;
}

var cases = {};

cases["a watch names its bus and says whether to start the daemon"] = function () {
    let calls = adapter();
    let appeared = function () {};
    let vanished = function () {};
    Harness.equal(Bus.watch("a.name", appeared, vanished, { gio: calls.gio }), 1,
                  "the id the bus answered is the id that comes back");
    Harness.deepEqual(calls.watched[0], ["system", "a.name", "none", appeared, vanished],
                      "the system bus, and a watch that starts nothing");
    Bus.watch("b.name", appeared, vanished,
              { gio: calls.gio, session: true, autoStart: true });
    Harness.deepEqual(calls.watched[1].slice(0, 3), ["session", "b.name", "auto"],
                      "the session bus, and a watch that asks for the daemon");
};

cases["a bus that only answers calls is still a bus"] = function () {
    /* Several injected buses are a bare object with one method on it. Reading
     * the enumerations off them would ask each to carry a copy of GLib's. */
    let seen = null;
    let gio = {
        bus_watch_name: function (type, name) {
            seen = [type, name];
            return 7;
        },
    };
    Harness.equal(Bus.watch("c.name", function () {}, function () {}, { gio: gio }), 7,
                  "the call is the adapter's");
    Harness.equal(seen[1], "c.name", "and the name is passed through");
    Harness.ok(seen[0] !== undefined, "with a real bus type rather than undefined");
};

cases["releasing a watch gives the id back to the bus that issued it"] = function () {
    let calls = adapter();
    Bus.release(12, calls.gio);
    Harness.deepEqual(calls.unwatched, [12], "the same registration is released");
};

cases["a runtime with no cancellable is answered with none"] = function () {
    let calls = adapter();
    Harness.equal(Bus.cancellable(calls.gio).kind, "token",
                  "a runtime that has one supplies it");
    Harness.equal(Bus.cancellable({}), null,
                  "and one that has not is not a failure");
};

cases["a proxy is built on the bus it was asked for, asynchronously"] = function () {
    let calls = adapter();
    let built = [];
    let answer = null;
    let wrapper = function (connection, name, path, onDone, cancellable) {
        built.push([connection, name, path, cancellable]);
        onDone("the proxy", null);
    };
    let token = { kind: "token" };
    Bus.proxy(wrapper, "a.name", "/a/path", (proxy, error) => { answer = [proxy, error]; },
              { gio: calls.gio, cancellable: token });
    Harness.deepEqual(built[0], ["system connection", "a.name", "/a/path", token],
                      "every D-Bus argument is preserved");
    Harness.deepEqual(answer, ["the proxy", null], "and the answer is forwarded");

    Bus.proxy(wrapper, "b.name", "/b/path", function () {},
              { gio: calls.gio, session: true });
    Harness.deepEqual(built[1].slice(0, 2), ["session connection", "b.name"],
                      "the session bus is the other one it can be built on");
    Harness.equal(built[1][3], null,
                  "and a caller with no cancellable passes null, not undefined");
};

cases["a proxy class is made from an interface description"] = function () {
    let made = null;
    let gio = { DBusProxy: { makeProxyWrapper: xml => { made = xml; return "wrapper"; } } };
    Harness.equal(Bus.wrapperFor("<node/>", gio), "wrapper", "the class comes back");
    Harness.equal(made, "<node/>", "built from the description it was given");
};

/*
 * The port's own claim, held to the tree rather than to a memory of it.
 *
 * lib/bus.js opens by saying it is the one place this applet reaches a daemon
 * through, and lib/upower.js built both of its proxy classes with
 * Gio.DBusProxy.makeProxyWrapper at module top level - so the sentence was
 * false, and false in the way that matters: a wrapper built before any caller
 * has said which runtime it means cannot honour an injected one, which is why
 * that module's cases had to hand the classes in from outside.
 *
 * A list of the modules that may would be a list somebody has to remember to
 * add to. This walks what is there.
 */
cases["nothing but the port builds a proxy class"] = function () {
    const Scan = imports.scan;
    const Sources = imports.sources;
    let offenders = [];
    let checked = 0;
    for (let relative of Sources.jsFiles(Harness.xletDir(), "")) {
        if (relative === "lib/bus.js")
            continue;
        /* Masked rather than searched as text: every module names the call in
         * its comments, and a gate a comment can satisfy - or that a comment
         * can fail - is not reading the code. */
        let code = Scan.mask(Harness.readFile(Harness.xletDir() + "/" + relative));
        checked++;
        if (code.indexOf("makeProxyWrapper") >= 0)
            offenders.push(relative + " builds a proxy class of its own");
        if (/\bnew\s+Gio\.DBusProxy\b/.test(code))
            offenders.push(relative + " constructs a proxy of its own");
    }
    Harness.deepEqual(offenders, [],
                      "every proxy class is built through Bus.wrapperFor");
    Harness.ok(checked > 20, "only " + checked + " sources checked, which is too few");
};

cases["the UPower bus builds its proxies from the runtime it was given"] = function () {
    /* The other half: not only that the port is used, but that using it means
     * the injected Gio is the one the classes come from. */
    let built = [];
    let gio = {
        DBusProxy: { makeProxyWrapper: xml => { built.push(xml); return function () {}; } },
    };
    const UPower = Harness.requireXlet("./lib/upower.js");
    UPower.systemBus(gio);
    Harness.equal(built.length, 2, "the manager and the device class, and no more");
    Harness.ok(built[0].indexOf('interface name="org.freedesktop.UPower"') >= 0,
               "the manager interface is the manager's");
    Harness.ok(built[1].indexOf('interface name="org.freedesktop.UPower.Device"') >= 0,
               "and the device interface the device's");
};
