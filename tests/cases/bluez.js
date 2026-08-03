/*
 * Bluetooth batteries from BlueZ.
 *
 * The D-Bus call is a parameter, so these run without bluetoothd and without
 * any device being switched on. The fixtures are the shape BlueZ's object
 * manager really answers with, taken from this machine's own tree.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Bluez = Harness.requireXlet("./lib/bluez.js");
const Log = Harness.requireXlet("./lib/log.js");
const UPowerGlib = imports.gi.UPowerGlib;

const Kind = UPowerGlib.DeviceKind;

const HEADSET = "/org/bluez/hci0/dev_F4_4E_FD_01_53_0F";
const MOUSE = "/org/bluez/hci0/dev_98_47_44_F9_EE_B2";

function tree(extra) {
    let objects = {
        "/org/bluez/hci0": { "org.bluez.Adapter1": { Powered: true } },
    };
    for (let path in extra || {})
        objects[path] = extra[path];
    return objects;
}

function device(name, icon, connected, percentage) {
    let interfaces = {
        "org.bluez.Device1": { Alias: name, Icon: icon, Connected: connected },
    };
    if (percentage !== undefined)
        interfaces["org.bluez.Battery1"] = { Percentage: percentage };
    return interfaces;
}

var cases = {};

cases["a connected device with a battery is reported"] = function () {
    let found = Bluez.parseObjects(tree({
        [HEADSET]: device("BW01", "audio-headset", true, 90),
    }));
    Harness.equal(found.length, 1, "one device");
    Harness.equal(found[0].model, "BW01", "named by its alias");
    Harness.equal(found[0].percentage, 90, "charge");
    Harness.equal(found[0].kind, Kind.HEADSET, "BlueZ's icon says what it is");
    Harness.equal(found[0].powerSupply, false, "it does not power the machine");
};

cases["a device with no alias is named by the name it broadcasts"] = function () {
    /*
     * The alias is what the desktop calls a device and is what BlueZ answers
     * with once anything has paired it; the name is what the device says it
     * is. A device that has never been renamed has both and they agree, and
     * one paired by something that never set an alias has only the second -
     * which is a row in the menu with no title on it.
     */
    let found = Bluez.parseObjects(tree({
        [HEADSET]: {
            "org.bluez.Device1": { Name: "WH-1000XM4", Icon: "audio-headset", Connected: true },
            "org.bluez.Battery1": { Percentage: 75 },
        },
        [MOUSE]: {
            "org.bluez.Device1": { Icon: "input-mouse", Connected: true },
            "org.bluez.Battery1": { Percentage: 40 },
        },
    }));

    Harness.equal(found.length, 2, "both are reported");
    Harness.equal(found.find(entry => entry.path === HEADSET).model, "WH-1000XM4",
                  "the name, where there is no alias");
    Harness.equal(found.find(entry => entry.path === MOUSE).model, "",
                  "and nothing where there is neither, rather than the word undefined");
};

cases["a device that is switched off is not reported"] = function () {
    let found = Bluez.parseObjects(tree({
        [HEADSET]: device("BW01", "audio-headset", false, 90),
    }));
    Harness.deepEqual(found, [],
                      "which is why the menu was empty on the machine this was written on");
};

cases["a connected device with no battery is not reported"] = function () {
    let found = Bluez.parseObjects(tree({
        [MOUSE]: device("MX Anywhere", "input-mouse", true),
    }));
    Harness.deepEqual(found, [], "nothing to say about it");
};

cases["the adapter itself is not a device"] = function () {
    Harness.deepEqual(Bluez.parseObjects(tree()), [], "only the adapter is there");
};

cases["BlueZ's icon names map onto UPower's kinds"] = function () {
    let found = Bluez.parseObjects(tree({
        [HEADSET]: device("A", "input-keyboard", true, 50),
        [MOUSE]: device("B", "input-mouse", true, 60),
    }));
    Harness.equal(found[0].kind, Kind.KEYBOARD, "keyboard");
    Harness.equal(found[1].kind, Kind.MOUSE, "mouse");

    let odd = Bluez.parseObjects(tree({
        [HEADSET]: device("C", "something-new", true, 70),
    }));
    Harness.equal(odd[0].kind, Kind.BLUETOOTH_GENERIC, "an icon we do not know");
};

cases["a device is recognised across the two naming schemes"] = function () {
    Harness.equal(Bluez.addressOf(HEADSET), "F4_4E_FD_01_53_0F", "BlueZ");
    Harness.equal(Bluez.addressOf("/org/freedesktop/UPower/devices/headset_dev_F4_4E_FD_01_53_0F"),
                  "F4_4E_FD_01_53_0F", "UPower calls the same device this");
    Harness.equal(Bluez.addressOf("/org/freedesktop/UPower/devices/battery_BAT0"), null,
                  "a laptop battery has no address");
};

cases["a device UPower already covers is not listed twice"] = function () {
    let called = [];
    let control = new Bluez.BluezBatteries(null, function (path, iface, method, onDone) {
        called.push(method);
        onDone(tree({ [HEADSET]: device("BW01", "audio-headset", true, 90),
                      [MOUSE]: device("MX", "input-mouse", true, 55) }));
    });

    Harness.equal(control.devices.length, 2, "BlueZ knows both");
    let fromUPower = [{ path: "/org/freedesktop/UPower/devices/headset_dev_F4_4E_FD_01_53_0F" }];
    let extra = control.missingFrom(fromUPower);
    Harness.equal(extra.length, 1, "one of them is new");
    Harness.equal(extra[0].model, "MX", "the one UPower did not mention");
    control.destroy();
};

cases["a machine with no bluetooth daemon says nothing and breaks nothing"] = function () {
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => onDone(null));
    Harness.equal(control.available, false, "not available");
    Harness.deepEqual(control.devices, [], "no devices");
    Harness.deepEqual(control.missingFrom([]), [], "and nothing to add");
    control.destroy();
};

cases["the module's own call answers rather than throwing"] = function () {
    /*
     * Every other case here hands in its own call, so the one this module
     * makes for itself - the only one a running applet uses - was exercised by
     * none of them. It reaches Gio.DBus.system, which is a getter that
     * connects and throws where there is nothing to connect to, and it is
     * called from the constructor: a throw there comes up through the applet's
     * constructor and leaves nothing on the panel at all.
     *
     * What is asserted is that it answers. Whether bluetoothd is on this bus,
     * or whether there is a bus, decides what the answer says and not whether
     * one arrives - which is the whole point.
     */
    /* Constructed with a call of its own so that building it reads nothing;
     * the real one is then asked directly. */
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => onDone(null));

    Harness.settle(function (done) {
        control._dbusCall("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", done);
    }, "the module's own D-Bus call");
    control.destroy();
};

cases["bluetoothd going away empties the list and says so"] = function () {
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let running = true;
    let changes = 0;
    let control = new Bluez.BluezBatteries(
        () => changes++,
        (path, iface, method, onDone) => onDone(running ? objects : null));

    Harness.equal(control.devices.length, 1, "one connected to begin with");
    Harness.equal(changes, 1, "which was news");

    running = false;
    control._refresh();
    Harness.equal(control.available, false, "the daemon is not there");
    Harness.deepEqual(control.devices, [], "so nothing is connected");
    Harness.equal(changes, 2,
                  "and the menu is told, rather than keeping the rows until the next poll");
    control.destroy();
};

cases["a daemon that was never there is not a change"] = function () {
    /* The empty answer is only news against a list that had something in it.
     * A desktop with no radio answers this way for the whole session. */
    let changes = 0;
    let control = new Bluez.BluezBatteries(() => changes++,
                                           (path, iface, method, onDone) => onDone(null));
    control._refresh();
    control._refresh();
    Harness.equal(changes, 0, "nothing changed, so nothing was said");
    control.destroy();
};

cases["a burst of signals is one read of the tree"] = function () {
    /*
     * What BlueZ does while an adapter is discovering: RSSI republished
     * several times a second per device, each of which used to be a
     * GetManagedObjects of its own for a value that cannot move a battery
     * percentage.
     */
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let reads = 0;
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => {
        reads++;
        onDone(objects);
    });
    Harness.equal(reads, 1, "the first read, taken as the control is built");

    for (let i = 0; i < 20; i++)
        control._scheduleRefresh();
    Harness.equal(reads, 1, "and none of the burst has gone out yet");

    Harness.settle(done => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Bluez.REFRESH_SETTLE_MS + 150,
                                            () => { done(); return GLib.SOURCE_REMOVE; }),
                   "the settle window");
    Harness.equal(reads, 2, "one read for the whole burst");

    /*
     * And the burst after it. The timer clears its own id as it fires, and
     * that is what lets the next one arm: leaving the id behind reads as a
     * timer already armed for the rest of the session, so every later signal
     * is dropped and the menu stops hearing about devices entirely.
     */
    control._scheduleRefresh();
    Harness.settle(done => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Bluez.REFRESH_SETTLE_MS + 150,
                                            () => { done(); return GLib.SOURCE_REMOVE; }),
                   "the next settle window");
    Harness.equal(reads, 3, "the next burst is read too");
    control.destroy();
};

cases["a refresh that has not fired yet is dropped with the control"] = function () {
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => onDone(tree()));
    control._scheduleRefresh();
    control.destroy();
    Harness.equal(control._refreshTimerId, 0,
                  "or the timer outlives the applet and fires into a destroyed object");
};

cases["a change is only reported when something actually changed"] = function () {
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let changes = 0;
    let control = new Bluez.BluezBatteries(() => changes++,
                                           (path, iface, method, onDone) => onDone(objects));
    Harness.equal(changes, 1, "the first answer is news");

    control._refresh();
    Harness.equal(changes, 1, "the same answer again is not");

    objects[HEADSET]["org.bluez.Battery1"].Percentage = 85;
    control._refresh();
    Harness.equal(changes, 2, "a new level is");
    control.destroy();
};

cases["a device renamed or reclassified is a change too"] = function () {
    /*
     * Both the alias and the icon come off org.bluez.Device1, which is watched
     * exactly so the list follows the device. Comparing only the path and the
     * percentage meant a rename reached this.devices and was reported to
     * nobody: the menu kept the old title until something else redrew it.
     */
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let changes = 0;
    let control = new Bluez.BluezBatteries(() => changes++,
                                           (path, iface, method, onDone) => onDone(objects));
    Harness.equal(changes, 1, "the first answer is news");

    objects[HEADSET]["org.bluez.Device1"].Alias = "Desk headset";
    control._refresh();
    Harness.equal(control.devices[0].model, "Desk headset", "the list takes the new name");
    Harness.equal(changes, 2, "and says so, because the name is the row's title");

    objects[HEADSET]["org.bluez.Device1"].Icon = "input-mouse";
    control._refresh();
    Harness.equal(changes, 3, "as is the kind, which is what the row's icon is chosen from");
    control.destroy();
};

cases["one read of the tree at a time"] = function () {
    /* The settle timer stops a burst arming twice; it does nothing about a
     * burst that spans two of them, and two GetManagedObjects then settle in
     * whatever order they come back in. */
    let waiting = [];
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => {
        waiting.push(onDone);
    });
    Harness.equal(waiting.length, 1, "the constructor's read");

    control._refresh();
    Harness.equal(waiting.length, 1, "and a second is not started on top of it");

    waiting.shift()(tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) }));
    Harness.equal(waiting.length, 1, "once the first answered, the next one may go");

    waiting.shift()(tree());
    Harness.equal(waiting.length, 0, "and nothing is left asking");
    control.destroy();
};

cases["a read asked for during a read is taken, not forgotten"] = function () {
    /*
     * Skipping the second read is right - two answers settling in whatever
     * order they arrive in can leave the older one winning. Forgetting it was
     * not: the timer that asked has already fired and cleared itself, so
     * nothing re-arms, and the headset that switched off stayed in the menu
     * until some unrelated signal happened along.
     */
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let waiting = [];
    let changes = 0;
    let control = new Bluez.BluezBatteries(() => changes++, (path, iface, method, onDone) => {
        waiting.push(onDone);
    });

    waiting.shift()(objects);
    Harness.equal(control.devices.length, 1, "the headset is connected");
    Harness.equal(changes, 1, "which was news");

    /* A read goes out; while it is in flight the headset is switched off and
     * BlueZ says so, which is the read that used to be dropped. */
    control._refresh();
    control._refresh();
    waiting.shift()(objects);
    Harness.equal(waiting.length, 1, "the skipped one was remembered");

    waiting.shift()(tree());
    Harness.deepEqual(control.devices, [], "so the headset leaves the list");
    Harness.equal(changes, 2, "and the menu is told, rather than waiting for the next signal");
    control.destroy();
};

/* ---------------------------------------------------------------- */
/* the reach for the bus itself                                     */

/* A control that has not touched the bus: the constructor's read is held, so
 * what follows is the only call it makes. */
function idle() {
    let waiting = [];
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => {
        waiting.push(onDone);
    });
    control.waiting = waiting;
    return control;
}

/*
 * Whether bluetoothd is on the bus, asked of the bus itself rather than of
 * BlueZ.
 *
 * Deciding that from a call to BlueZ that came back empty would mean a module
 * which had stopped talking to it entirely - a timeout of nought, a method
 * renamed - read as a machine with no Bluetooth, and the case below would
 * quietly skip instead of failing. This asks a different question of a
 * different service, so the answer to it cannot be broken by anything here.
 */
function haveBluez() {
    let connection;
    try {
        connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
    } catch (error) {
        return false;
    }
    let owned = connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                                     "org.freedesktop.DBus", "NameHasOwner",
                                     new GLib.Variant("(s)", ["org.bluez"]), null,
                                     Gio.DBusCallFlags.NONE, -1, null);
    return owned.deepUnpack()[0];
}

cases["a call BlueZ cannot answer is nothing, not a failure"] = function () {
    /*
     * Every case above hands in a call of its own, so the one this module
     * really makes was exercised by none of them. What it decides is what the
     * whole module makes of a machine with no radio: a reply that is not there
     * has to read as an empty tree, because a desktop with no Bluetooth in it
     * is an ordinary desktop and not an error to report.
     *
     * A method nobody exports is the same shape of failure as bluetoothd not
     * running - the reply is an error either way - and asking for one is how
     * this reaches that answer on a machine where bluetoothd is running.
     */
    let control = idle();
    try {
        let answer = Harness.settle(done => control._dbusCall(
            "/", "org.freedesktop.DBus.Peer", "NoSuchMethod", done),
            "a method nobody answers");
        Harness.equal(answer, null, "no tree, and nothing thrown");
    } finally {
        control.destroy();
    }
};

cases["a call that cannot be made at all is nothing either"] = function () {
    /*
     * Gio.DBus.system is a getter that connects, and it throws rather than
     * answering where there is no system bus - which is the case this guard
     * was written for and the one machine these tests cannot be run on. A
     * call it will not even attempt reaches the same guard, and that is what
     * is asked for here: the throw happens where the call is made, before
     * anything is sent, exactly as a missing bus would.
     *
     * It is called from the constructor, so a throw getting out is an applet
     * with nothing on the panel at all.
     */
    let control = idle();
    try {
        let answers = [];
        control._dbusCall("/", {}, "GetManagedObjects", value => answers.push(value));
        Harness.deepEqual(answers, [null], "answered once, with nothing");
    } finally {
        control.destroy();
    }
};

cases["a watch that cannot be set up is logged, not thrown"] = function () {
    /*
     * The same reach, in the other place it is made. A subscription that
     * cannot be set up costs the applet its updates - devices come and go
     * without the menu hearing - and that is worth a line in the log; it is
     * not worth taking the constructor down, since the tree is still read.
     */
    let control = idle();
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        control._subscribe({}, "PropertiesChanged", "org.bluez.Battery1");
    } finally {
        Log.setSink(null);
        control.destroy();
    }

    Harness.equal(lines.length, 1, "one line said about it");
    Harness.ok(lines[0].indexOf("cannot watch BlueZ for PropertiesChanged") >= 0,
               "naming the signal that is no longer watched: " + lines[0]);
    Harness.ok(lines[0].indexOf("on org.bluez.Battery1") >= 0,
               "and the interface it was for, since there are three of these: " + lines[0]);
};

cases["the tree BlueZ really answers with is one this module can read"] = function () {
    /*
     * The fixtures above were taken from this machine's tree, and a fixture is
     * a copy of what was true once. This asks the daemon itself, on a machine
     * that has one, and skips where there is none - the same trade as
     * tests/cases/live.js, and for the same reason: a build that goes red for
     * having no Bluetooth teaches everybody to ignore red.
     */
    if (!haveBluez())
        Harness.skip("no bluetoothd on this bus");

    let control = idle();
    try {
        let objects = Harness.settle(done => control._dbusCall(
            "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", done),
            "BlueZ's object tree");

        Harness.ok(objects, "the daemon is running, so its tree has to arrive");
        Harness.equal(typeof objects, "object", "a tree of objects");
        for (let path in objects)
            Harness.equal(typeof objects[path], "object",
                          path + " carries a set of interfaces");

        /* Whatever is really plugged in, what this module makes of it has to
         * be rows the menu can draw. */
        for (let found of Bluez.parseObjects(objects)) {
            Harness.ok(found.path, "a device with no path");
            Harness.equal(typeof found.percentage, "number", found.path + ": a charge");
            Harness.equal(typeof found.kind, "number", found.path + ": a kind");
        }
    } finally {
        control.destroy();
    }
};
