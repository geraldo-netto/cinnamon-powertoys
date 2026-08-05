/*
 * The two D-Bus backends against whatever is really on the system bus.
 *
 * Every other case here runs against a fixture or a stub, which is what makes
 * them worth running anywhere - but it also means nothing in this suite has
 * ever spoken to UPower or to a power profiles daemon. The interface XML could
 * name a property that does not exist, or a signal that was renamed, and every
 * test would still pass.
 *
 * So these talk to the real thing when there is a real thing, and say they
 * were skipped when there is not. A machine with no system bus - which is what
 * CI is - has nothing to tell us, and a build that goes red for that reason
 * teaches everybody to ignore red.
 *
 * What they check is deliberately shallow: that the backend answers at all,
 * and that what it answers is the shape the applet is written against. Any
 * assertion about a particular number would be an assertion about the machine
 * the tests happen to be running on.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Harness = imports.harness;

const UPower = Harness.requireXlet("./lib/upower.js");
const Profiles = Harness.requireXlet("./lib/profiles.js");

/* Whether there is a system bus at all. This is the whole of the "can these
 * run here" question: everything below needs one and nothing else. */
function haveSystemBus() {
    try {
        return Gio.bus_get_sync(Gio.BusType.SYSTEM, null) !== null;
    } catch (error) {
        return false;
    }
}

function needSystemBus() {
    if (!haveSystemBus())
        Harness.skip("no system bus here");
}

var cases = {};

cases["UPower answers the questions the applet asks it"] = function () {
    needSystemBus();

    let monitor = new UPower.UPowerMonitor(function () {}, function () {});
    try {
        /* The monitor reports itself ready once it has enumerated, whether or
         * not UPower was there, so this waits for an answer either way. */
        Harness.settle(function (done) {
            monitor._onReady = done;
            if (monitor.available)
                done();
        }, "UPower enumeration");

        if (!monitor.available)
            Harness.skip("UPower is not on this bus");

        let reading = monitor.read();
        Harness.equal(reading.available, true, "available");
        Harness.ok(Array.isArray(reading.devices), "devices is a list");
        Harness.ok(Array.isArray(reading.lines), "lines is a list");
        Harness.ok(Array.isArray(reading.temperatures), "temperatures is a list");
        Harness.ok(Array.isArray(reading.powers), "powers is a list");
        Harness.equal(typeof reading.onBattery, "boolean", "onBattery");

        /*
         * Every device it describes has to carry what the menu and the alert
         * policy read off it. This is the assertion that would have caught a
         * property that quietly stopped arriving.
         */
        for (let device of reading.devices) {
            Harness.ok(device.path, "a device with no path");
            Harness.equal(typeof device.kind, "number", device.path + ": kind");
            Harness.equal(typeof device.state, "number", device.path + ": state");
            Harness.equal(typeof device.powerSupply, "boolean", device.path + ": powerSupply");
            Harness.ok(device.percentage === null || typeof device.percentage === "number",
                       device.path + ": percentage is a number or nothing");
        }
    } finally {
        monitor.destroy();
    }
};

cases["a power profiles daemon answers the questions the applet asks it"] = function () {
    needSystemBus();

    /*
     * The client looks for the daemon asynchronously - see systemBus().proxy,
     * which is not allowed to block the thread that draws the desktop - so
     * `available` is false the instant it is built, whether or not a daemon is
     * there. Asking too early is how this case would quietly start skipping on
     * a machine that has one, which is the whole of what it exists to catch.
     *
     * A machine with no daemon never calls back at all. That is an answer too
     * and not something to fail over, so the deadline is beside the callback
     * rather than instead of it.
     */
    let client = null;
    Harness.settle(function (done) {
        let answered = false;
        let settle = () => {
            if (answered)
                return;
            answered = true;
            done();
        };
        client = new Profiles.PowerProfilesClient(settle);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            settle();
            return GLib.SOURCE_REMOVE;
        });
    }, "the power profiles daemon");

    try {
        if (!client.available)
            Harness.skip("no power profiles daemon on this bus");

        Harness.ok(Profiles.BACKENDS.some(backend => backend.name === client.busName),
                   "answered on a bus name this applet knows: " + client.busName);

        let profiles = client.profiles;
        Harness.ok(Array.isArray(profiles) && profiles.length > 0, "it offers profiles");
        Harness.equal(profiles.every(name => typeof name === "string" && name !== ""), true,
                      "each one named: " + profiles.join(", "));
        Harness.ok(profiles.indexOf(client.active) >= 0,
                   "the active profile is one of them: " + client.active);
        Harness.equal(typeof client.degraded, "string", "degraded is a string, empty when it is not");
        Harness.ok(Array.isArray(client.holds), "holds is a list");
    } finally {
        client.destroy();
    }
};

cases["the write this applet makes reaches a real daemon"] = function () {
    /*
     * The one call in lib/profiles.js that is not made through a proxy: a
     * Properties.Set on the system bus, which is how every profile the user
     * picks is applied. Everything either side of it is covered against a
     * stubbed bus in profiles.js, and this is the part a stub cannot say
     * anything about - whether the variant is packed the way the daemon reads
     * it, and whether a refusal comes back as an error rather than as silence.
     *
     * What it writes is the profile that is already in force, so the machine
     * running these is left exactly as it was found. The daemon does not treat
     * that as a special case, so the call is the same call, and the answer to
     * it is the answer the menu reads.
     */
    needSystemBus();

    let client = null;
    Harness.settle(function (done) {
        let answered = false;
        let settle = () => {
            if (answered)
                return;
            answered = true;
            done();
        };
        client = new Profiles.PowerProfilesClient(settle);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            settle();
            return GLib.SOURCE_REMOVE;
        });
    }, "the power profiles daemon");

    try {
        if (!client.available)
            Harness.skip("no power profiles daemon on this bus");

        let active = client.active;
        let failure = Harness.settle(done => Profiles.systemBus().setProperty(
            client.busName, client.busPath, "ActiveProfile", active, done),
            "a write of the profile already in force");
        Harness.equal(failure, null, "the daemon took it, and said so by saying nothing");
        Harness.equal(client.active, active, "and the machine is where it was found");
    } finally {
        client.destroy();
    }
};

cases["a write to a daemon that is not there comes back as a refusal"] = function () {
    /*
     * The other half, and the one that does not need a daemon: a name nobody
     * owns. The applet shows what the error says, so an error that never
     * arrives is a profile the user picked, never got, and was never told
     * about.
     */
    needSystemBus();

    let failure = Harness.settle(done => Profiles.systemBus().setProperty(
        "org.freedesktop.UPower.PowerProfiles.NotHere", "/nothing/here",
        "ActiveProfile", "balanced", done), "a write to a name nobody owns");

    Harness.ok(failure, "an error, rather than a write that quietly went nowhere");
    Harness.ok(String(failure.message || failure).length > 0,
               "with something the menu can show: " + failure);
};
