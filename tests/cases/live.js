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
        Harness.equal(typeof reading.lineOnline, "boolean", "lineOnline");

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

    let client = new Profiles.PowerProfilesClient(function () {});
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
