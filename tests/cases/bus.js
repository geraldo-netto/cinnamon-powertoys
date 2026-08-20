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
