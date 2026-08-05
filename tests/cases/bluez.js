/*
 * Bluetooth batteries from BlueZ.
 *
 * The D-Bus call is a parameter, so these run without bluetoothd and without
 * any device being switched on. The fixtures are the shape BlueZ's object
 * manager really answers with, taken from this machine's own tree.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Fuzz = imports.fuzz;
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

cases["the production owner adapter preserves edges and cleanup"] = function () {
    let watched = null;
    let removed = [];
    let bus = {
        bus_watch_name: function (type, name, flags, appeared, vanished) {
            watched = { name: name, appeared: appeared, vanished: vanished };
            return 29;
        },
        bus_unwatch_name: id => removed.push(id),
    };
    let events = [];
    let unwatch = Bluez.systemNameWatcher(() => events.push("appeared"),
                                          () => events.push("vanished"), bus);
    Harness.equal(watched.name, Bluez.BUS_NAME, "BlueZ is the watched owner");
    watched.appeared();
    watched.vanished();
    Harness.deepEqual(events, ["appeared", "vanished"], "both edges are forwarded");
    unwatch();
    Harness.deepEqual(removed, [29], "the returned cleanup releases the watch");

    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        Harness.equal(Bluez.systemNameWatcher(() => {}, () => {}, {
            bus_watch_name: () => { throw new Error("watch failed"); },
        }), null, "a failed watch has no cleanup token");
    } finally {
        Log.setSink(null);
    }
    Harness.equal(lines.length, 1, "the setup failure is recorded");
    Harness.ok(lines[0].indexOf("watch failed") >= 0, "the original failure is retained");
};

function signalBus() {
    let bus = { subscriptions: [], removed: [] };
    bus.signal_subscribe = function (name, iface, member, path, arg0, flags, callback) {
        let entry = { id: bus.subscriptions.length + 1, iface: iface, member: member,
                      arg0: arg0, callback: callback };
        bus.subscriptions.push(entry);
        return entry.id;
    };
    bus.signal_unsubscribe = id => bus.removed.push(id);
    return bus;
}

cases["the injected signal transport drives every BlueZ delta"] = function () {
    let bus = signalBus();
    let reads = 0;
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => { reads++; onDone(tree()); }, null, bus);
    Harness.equal(bus.subscriptions.length, 4, "the two object and two property edges are wired");

    let added = bus.subscriptions.find(entry => entry.member === "InterfacesAdded");
    added.callback(null, null, HEADSET, null, null, { deepUnpack: () => [HEADSET,
        device("BW01", "audio-headset", true, 90)] });
    Harness.equal(control.devices.length, 1, "an unpacked add reaches the cache");

    let battery = bus.subscriptions.find(entry => entry.member === "PropertiesChanged" &&
                                                  entry.arg0 === "org.bluez.Battery1");
    battery.callback(null, null, HEADSET, null, null,
                     ["org.bluez.Battery1", { Percentage: 72 }, []]);
    Harness.equal(control.devices[0].percentage, 72, "a plain-array property delta reaches it too");

    let removed = bus.subscriptions.find(entry => entry.member === "InterfacesRemoved");
    removed.callback(null, null, HEADSET, null, null,
                     { deepUnpack: () => [HEADSET, ["org.bluez.Battery1"]] });
    Harness.deepEqual(control.devices, [], "a remove reaches the cache");

    battery.callback(null, null, HEADSET, null, null, {
        deepUnpack: () => { throw new Error("malformed signal"); },
    });
    Harness.ok(control._refreshTimerId, "an undecodable watched signal schedules repair");
    control.destroy();
    Harness.deepEqual(bus.removed, [1, 2, 3, 4], "every injected subscription is released");
    added.callback(null, null, HEADSET, null, null, []);
    Harness.equal(reads, 1, "a late signal does not read after teardown");
};

cases["a failed injected signal subscription is contained"] = function () {
    let lines = [];
    let bus = {
        signal_subscribe: () => { throw new Error("subscription failed"); },
        signal_unsubscribe: () => {},
    };
    Log.setSink(line => lines.push(line));
    let control;
    try {
        control = new Bluez.BluezBatteries(null,
            (path, iface, method, onDone) => onDone(tree()), null, bus);
    } finally {
        Log.setSink(null);
    }
    Harness.equal(lines.length, 4, "each unavailable edge is named once");
    Harness.equal(control.available, true, "the initial snapshot remains usable");
    control.destroy();
};

function nameWatcher() {
    let watcher = { appeared: null, vanished: null, unwatched: 0 };
    watcher.watch = function (appeared, vanished) {
        watcher.appeared = appeared;
        watcher.vanished = vanished;
        return () => watcher.unwatched++;
    };
    return watcher;
}

function initialNameWatcher() {
    let watcher = nameWatcher();
    let install = watcher.watch;
    watcher.watch = function (appeared, vanished) {
        let remove = install(appeared, vanished);
        appeared();
        return remove;
    };
    watcher.watch.reportsInitialState = true;
    return watcher;
}

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

cases["Bluetooth rows are sorted by their displayed names"] = function () {
    let found = Bluez.parseObjects(tree({
        [HEADSET]: device("Alpha", "audio-headset", true, 50),
        [MOUSE]: device("Bravo", "input-mouse", true, 60),
        "/org/bluez/hci0/dev_00_00_00_00_00_03":
            device("Delta", "input-keyboard", true, 70),
        "/org/bluez/hci0/dev_00_00_00_00_00_04":
            device("Charlie", "phone", true, 80),
    }));
    Harness.deepEqual(found.map(entry => entry.model),
                      ["Alpha", "Bravo", "Charlie", "Delta"],
                      "a late descending pair cannot survive insertion order");
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
    let reads = 0;
    let changes = 0;
    let watcher = nameWatcher();
    let control = new Bluez.BluezBatteries(
        () => changes++,
        (path, iface, method, onDone) => { reads++; onDone(objects); }, watcher.watch);

    Harness.equal(control.devices.length, 1, "one connected to begin with");
    Harness.equal(changes, 1, "which was news");

    watcher.vanished();
    Harness.equal(control.available, false, "the daemon is not there");
    Harness.deepEqual(control.devices, [], "so nothing is connected");
    Harness.equal(changes, 2,
                  "and the menu is told, rather than keeping the rows until the next poll");

    objects = tree({ [MOUSE]: device("MX", "input-mouse", true, 55) });
    watcher.appeared();
    Harness.equal(reads, 2, "reappearance reads a fresh object tree");
    Harness.equal(control.devices[0].model, "MX", "the restarted daemon's device replaces it");
    Harness.equal(control.available, true, "available again after the fresh answer");
    control.destroy();
    Harness.equal(watcher.unwatched, 1, "the ownership watch is released");
};

cases["owner loss cancels pending repair and ignores later owner edges"] = function () {
    let watcher = nameWatcher();
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => onDone(tree()), watcher.watch);
    control._scheduleRefresh();
    Harness.ok(control._refreshTimerId, "a repair timer is pending");
    watcher.vanished();
    Harness.equal(control._refreshTimerId, 0, "owner loss removes the obsolete timer");
    control.destroy();
    watcher.vanished();
    watcher.appeared();
    Harness.equal(control.available, false, "late owner edges cannot revive a destroyed client");
};

cases["the owner watch performs the only production startup read"] = function () {
    let reads = 0;
    let watcher = initialNameWatcher();
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => { reads++; onDone(tree()); }, watcher.watch);

    Harness.equal(reads, 1,
                  "subscription and current ownership produce one GetManagedObjects call");
    control.destroy();
};

cases["owner loss cancels the obsolete object-tree read"] = function () {
    let waiting = [];
    let watcher = nameWatcher();
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone, cancellable) =>
            waiting.push({ done: onDone, cancellable: cancellable }), watcher.watch);

    Harness.equal(waiting.length, 1, "one startup read is in flight");
    watcher.vanished();
    Harness.equal(waiting[0].cancellable.is_cancelled(), true,
                  "the old daemon's work is stopped immediately");

    watcher.appeared();
    Harness.equal(waiting.length, 2, "the replacement daemon gets an independent read");
    waiting[0].done(tree({ [HEADSET]: device("stale", "audio-headset", true, 10) }));
    Harness.deepEqual(control.devices, [], "the cancelled answer cannot repopulate the cache");
    waiting[1].done(tree({ [MOUSE]: device("live", "input-mouse", true, 80) }));
    Harness.equal(control.devices[0].model, "live", "the replacement answer is adopted");
    control.destroy();
};

cases["BlueZ signal payloads update the cached tree without a round trip"] = function () {
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let reads = 0;
    let changes = 0;
    let control = new Bluez.BluezBatteries(() => changes++,
        (path, iface, method, onDone) => { reads++; onDone(objects); });
    let initialChanges = changes;

    control._propertiesChanged(HEADSET,
        ["org.bluez.Device1", { RSSI: -48 }, []]);
    Harness.equal(reads, 1, "an irrelevant high-frequency property is ignored");
    Harness.equal(changes, initialChanges, "RSSI cannot alter a displayed row");

    control._propertiesChanged(HEADSET,
        ["org.bluez.Battery1", { Percentage: 75 }, []]);
    Harness.equal(control.devices[0].percentage, 75, "battery charge is applied directly");
    Harness.equal(reads, 1, "without GetManagedObjects");

    control._propertiesChanged(HEADSET,
        ["org.bluez.Device1", { Alias: "Desk headset" }, []]);
    Harness.equal(control.devices[0].model, "Desk headset", "a rename is applied too");
    Harness.equal(reads, 1, "and still costs no full-tree read");

    control._interfacesRemoved([HEADSET, ["org.bluez.Battery1"]]);
    Harness.deepEqual(control.devices, [], "removing the battery interface removes the row");
    control._interfacesAdded([HEADSET,
        { "org.bluez.Battery1": { Percentage: 66 } }]);
    Harness.equal(control.devices[0].percentage, 66, "adding it back restores the row");
    Harness.equal(reads, 1, "interface deltas also stay local");
    control.destroy();
};

cases["invalidated displayed properties are repaired by one snapshot"] = function () {
    let answer = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let reads = 0;
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => { reads++; onDone(cloneTree(answer)); });

    control._propertiesChanged(HEADSET,
        ["org.bluez.Device1", {}, ["Alias", "Connected"]]);
    let repairTimer = control._refreshTimerId;
    Harness.ok(repairTimer, "a watched invalidation schedules a repair snapshot");
    Harness.equal(control.devices[0].model, "BW01",
                  "the last complete row remains visible until repair");

    control._propertiesChanged(HEADSET,
        ["org.bluez.Battery1", {}, ["Percentage"]]);
    Harness.equal(control._refreshTimerId, repairTimer,
                  "several invalidations coalesce into the pending repair");
    Harness.equal(reads, 1, "the repair waits for its settle window");

    answer = tree({ [HEADSET]: device("Desk headset", "audio-headset", true, 72) });
    GLib.source_remove(repairTimer);
    control._refreshTimerId = 0;
    control._refresh();
    Harness.equal(reads, 2, "one complete snapshot repairs the invalid values");
    Harness.equal(control.devices[0].model, "Desk headset", "the repaired alias is adopted");
    Harness.equal(control.devices[0].percentage, 72, "the repaired charge is adopted");
    control.destroy();
};

cases["a delta racing the initial snapshot requests one repair read"] = function () {
    let waiting = [];
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => waiting.push(onDone));

    control._propertiesChanged(HEADSET,
        ["org.bluez.Battery1", { Percentage: 25 }, []]);
    control._propertiesChanged(HEADSET,
        ["org.bluez.Battery1", { Percentage: 20 }, []]);
    Harness.equal(waiting.length, 1, "deltas do not overlap the initial snapshot");

    waiting.shift()(tree({ [HEADSET]: device("BW01", "audio-headset", true, 30) }));
    Harness.equal(waiting.length, 1, "the whole race coalesces into one repair snapshot");
    waiting.shift()(tree({ [HEADSET]: device("BW01", "audio-headset", true, 20) }));
    Harness.equal(control.devices[0].percentage, 20, "the post-race state wins");
    control.destroy();
};

cases["a cacheless delta after a failed snapshot starts a repair"] = function () {
    let answers = [null, tree({ [HEADSET]: device("BW01", "audio-headset", true, 44) })];
    let reads = 0;
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => {
        reads++;
        onDone(answers.shift());
    });
    control._interfacesAdded([HEADSET, { "org.bluez.Battery1": { Percentage: 44 } }]);
    Harness.equal(reads, 2, "the delta triggers a repair when no read is in flight");
    Harness.equal(control.devices[0].percentage, 44, "the repair supplies the complete device");
    control.destroy();
};

cases["malformed and irrelevant interface additions are ignored safely"] = function () {
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => onDone(tree()));
    for (let args of [[], [42, {}], [HEADSET, null],
                      [HEADSET, { "org.bluez.Adapter1": { Powered: true } }]])
        control._interfacesAdded(args);
    Harness.deepEqual(control.devices, [], "none can create a battery row");
    control.destroy();
};

cases["malformed and irrelevant interface removals are ignored safely"] = function () {
    let control = new Bluez.BluezBatteries(null,
        (path, iface, method, onDone) => onDone(tree()));
    for (let args of [[], [42, []], [HEADSET, null],
                      [HEADSET, ["org.bluez.Adapter1"]]])
        control._interfacesRemoved(args);
    Harness.deepEqual(control.devices, [], "none can remove or create a battery row");
    control.destroy();
};

cases["a throwing object-tree transport settles as unavailable"] = function () {
    let control = new Bluez.BluezBatteries(null, () => { throw new Error("call failed"); });
    Harness.equal(control.available, false, "the failed snapshot is contained");
    Harness.deepEqual(control.devices, [], "with no stale devices");
    control.destroy();
};

cases["a throwing name watcher falls back to the initial snapshot"] = function () {
    let reads = 0;
    let lines = [];
    Log.setSink(line => lines.push(line));
    let control;
    try {
        control = new Bluez.BluezBatteries(null,
            (path, iface, method, onDone) => { reads++; onDone(tree()); },
            () => { throw new Error("watch failed"); });
    } finally {
        Log.setSink(null);
    }
    Harness.equal(reads, 1, "the snapshot still runs");
    Harness.equal(lines.length, 1, "the watch failure is logged");
    Harness.ok(lines[0].indexOf("watch failed") >= 0,
               "the owner-watch diagnostic retains the original error");
    control.destroy();
};

cases["a reply from before bluetoothd vanished cannot restore stale devices"] = function () {
    let first = true;
    let waiting = [];
    let watcher = nameWatcher();
    let objects = tree({ [HEADSET]: device("BW01", "audio-headset", true, 90) });
    let control = new Bluez.BluezBatteries(null, (path, iface, method, onDone) => {
        if (first) {
            first = false;
            onDone(objects);
        } else {
            waiting.push(onDone);
        }
    }, watcher.watch);

    control._refresh();
    Harness.equal(waiting.length, 1, "one old-daemon read is in flight");
    watcher.vanished();
    waiting.shift()(objects);
    Harness.deepEqual(control.devices, [], "the stale reply is ignored after the owner changed");
    Harness.equal(control.available, false, "and cannot make the vanished daemon available");
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
     * Unexpected or malformed relevant signals fall back to a snapshot. A
     * burst of those still coalesces rather than multiplying full-tree reads.
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

/* ---------------------------------------------------------------- */
/* a tree nobody here wrote                                          */

/*
 * BlueZ's object tree is whatever bluetoothd has in memory, unpacked out of a
 * variant by GJS. A device half way through pairing carries an interface with
 * no properties on it; one that has just connected carries an Icon a moment
 * later than it carries a Battery; a firmware that reports a percentage as a
 * string is a firmware somebody is running.
 *
 * The rows this makes of that are what the menu draws, so what is held here is
 * their shape: a title that is a string, a charge that is a number, and no
 * row at all where there is nothing to say.
 */
function fuzzTree(random) {
    let objects = {};
    let count = random.below(4);
    for (let i = 0; i < count; i++) {
        let path = random.chance(4) ? Fuzz.text(random, 3)
                                    : "/org/bluez/hci0/dev_" + random.between(10, 99);
        let interfaces = {};
        if (!random.chance(6)) {
            /*
             * The types are the ones the interface declares - a property BlueZ
             * publishes as a string arrives as one - so what is varied is what
             * is missing, what is empty, and what a name can contain. A
             * property that has not arrived yet is the ordinary case: BlueZ
             * works an Icon out a moment after a device connects.
             */
            let device = {};
            if (!random.chance(3))
                device.Alias = Fuzz.text(random, 3);
            if (!random.chance(3))
                device.Name = Fuzz.text(random, 3);
            if (!random.chance(3))
                device.Icon = random.chance(2) ? random.pick(["audio-headset", "input-mouse",
                                                              "input-keyboard", "phone"])
                                               : Fuzz.text(random, 2);
            if (!random.chance(4))
                device.Connected = random.chance(2);
            interfaces["org.bluez.Device1"] = device;
        }
        if (random.chance(2)) {
            /* Percentage is a byte on the wire, and the module still asks
             * whether it is a number: a device half way through pairing
             * publishes the interface before the value. */
            interfaces["org.bluez.Battery1"] = random.chance(4)
                ? {} : { Percentage: random.chance(5) ? Fuzz.value(random)
                                                      : random.between(0, 100) };
        }
        if (random.chance(5))
            interfaces[Fuzz.text(random, 2)] = { Anything: Fuzz.value(random) };
        objects[path] = interfaces;
    }
    return objects;
}

function cloneTree(objects) {
    let copy = {};
    for (let path in objects) {
        copy[path] = {};
        for (let iface in objects[path])
            copy[path][iface] = Object.assign({}, objects[path][iface]);
    }
    return copy;
}

function rowKeys(objects) {
    return Bluez.parseObjects(objects).map(entry =>
        [entry.path, entry.model, entry.kind, entry.percentage]);
}

cases["whatever BlueZ has in memory becomes rows or nothing"] = function () {
    Fuzz.forAll({ what: "the tree parsing", runs: 400 }, fuzzTree, function (objects) {
        let found = Fuzz.answers(() => Bluez.parseObjects(objects));

        for (let entry of found) {
            Fuzz.isString(entry.model, "the row title");
            Harness.equal(typeof entry.percentage, "number",
                          "a charge that is a number: " + JSON.stringify(entry.percentage));
            Harness.equal(typeof entry.kind, "number", "a kind the menu can pick an icon by");
            Harness.equal(entry.powerSupply, false, "nothing here powers the machine");
            Harness.ok(entry.path in objects, "and every row came out of the tree");
        }
    });
};

cases["a list that follows a fuzzed tree only reports what changed"] = function () {
    /*
     * The other half: two trees in a row, and whether the menu is told. It is
     * told when a row would be drawn differently and not when it would not,
     * whatever the trees carried - a redraw per poll is a menu that flickers,
     * and no redraw on a change is a stale charge.
     */
    Fuzz.forAll({ what: "the change reporting", runs: 200 }, function (random) {
        return [fuzzTree(random), fuzzTree(random)];
    }, function (trees) {
        let answer = null;
        let changes = 0;
        let control = new Bluez.BluezBatteries(() => changes++,
                                               (path, iface, method, onDone) => onDone(answer));
        answer = trees[0];
        Fuzz.answers(() => control._refresh());
        let first = control.devices.map(entry => entry.path + ":" + entry.percentage +
                                                 ":" + entry.model + ":" + entry.kind).join("|");

        let told = changes;
        answer = trees[1];
        Fuzz.answers(() => control._refresh());
        let second = control.devices.map(entry => entry.path + ":" + entry.percentage +
                                                  ":" + entry.model + ":" + entry.kind).join("|");

        Harness.equal(changes > told, first !== second,
                      "told exactly when the rows would be drawn differently");
        control.destroy();
    });
};

cases["fuzzed BlueZ deltas stay equivalent to a fresh tree parse"] = function () {
    Fuzz.forAll({ what: "incremental BlueZ mutations", runs: 160 }, function (random) {
        let actions = [];
        let count = random.between(1, 25);
        for (let i = 0; i < count; i++) {
            actions.push({
                type: random.between(0, 7),
                path: random.chance(2) ? HEADSET : MOUSE,
                number: random.between(0, 100),
                text: Fuzz.text(random, 3),
                flag: random.chance(2),
            });
        }
        return actions;
    }, function (actions) {
        let expected = tree({
            [HEADSET]: device("Headset", "audio-headset", true, 90),
            [MOUSE]: device("Mouse", "input-mouse", true, 60),
        });
        let reads = 0;
        let repairs = 0;
        let control = new Bluez.BluezBatteries(null,
            (path, iface, method, onDone) => { reads++; onDone(cloneTree(expected)); });

        for (let action of actions) {
            let interfaces = expected[action.path] || (expected[action.path] = {});
            let deviceProps = interfaces["org.bluez.Device1"];
            let batteryProps = interfaces["org.bluez.Battery1"];
            if (action.type === 0) {
                if (!batteryProps) {
                    batteryProps = { Percentage: action.number };
                    interfaces["org.bluez.Battery1"] = batteryProps;
                    control._interfacesAdded([action.path,
                        { "org.bluez.Battery1": Object.assign({}, batteryProps) }]);
                } else {
                    batteryProps.Percentage = action.number;
                    control._propertiesChanged(action.path,
                        ["org.bluez.Battery1", { Percentage: action.number }, []]);
                }
            } else if (action.type >= 1 && action.type <= 4) {
                if (!deviceProps) {
                    deviceProps = { Alias: action.text, Name: "Device",
                                    Icon: "audio-headset", Connected: true };
                    interfaces["org.bluez.Device1"] = deviceProps;
                    control._interfacesAdded([action.path,
                        { "org.bluez.Device1": Object.assign({}, deviceProps) }]);
                } else if (action.type === 1) {
                    deviceProps.Alias = action.text;
                    control._propertiesChanged(action.path,
                        ["org.bluez.Device1", { Alias: action.text }, []]);
                } else if (action.type === 2) {
                    deviceProps.Connected = action.flag;
                    control._propertiesChanged(action.path,
                        ["org.bluez.Device1", { Connected: action.flag }, []]);
                } else if (action.type === 3) {
                    deviceProps.Icon = action.flag ? "input-mouse" : "audio-headset";
                    control._propertiesChanged(action.path,
                        ["org.bluez.Device1", { Icon: deviceProps.Icon }, []]);
                } else {
                    deviceProps.RSSI = -action.number;
                    control._propertiesChanged(action.path,
                        ["org.bluez.Device1", { RSSI: deviceProps.RSSI }, []]);
                }
            } else if (action.type === 5) {
                delete interfaces["org.bluez.Battery1"];
                control._interfacesRemoved([action.path, ["org.bluez.Battery1"]]);
            } else if (action.type === 6) {
                delete interfaces["org.bluez.Device1"];
                control._interfacesRemoved([action.path, ["org.bluez.Device1"]]);
            } else if (deviceProps) {
                delete deviceProps.Alias;
                control._propertiesChanged(action.path,
                    ["org.bluez.Device1", {}, ["Alias"]]);
                Harness.ok(control._refreshTimerId,
                           "a fuzzed invalidation schedules its repair");
                GLib.source_remove(control._refreshTimerId);
                control._refreshTimerId = 0;
                control._refresh();
                repairs++;
            }

            Harness.deepEqual(control.devices.map(entry =>
                [entry.path, entry.model, entry.kind, entry.percentage]), rowKeys(expected),
                "the incremental rows equal a full parse after every mutation");
        }
        Harness.equal(reads, 1 + repairs,
                      "only invalidations fall back to a repair snapshot");
        control.destroy();
    });
};
