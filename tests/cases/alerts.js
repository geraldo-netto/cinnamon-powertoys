/*
 * When the applet interrupts somebody.
 *
 * The class was written with a notify parameter so that "a run of readings can
 * be pushed through it and the notifications counted", and then lived in
 * applet.js, which cannot be loaded outside Cinnamon - so for as long as it has
 * existed, the seam was there and nothing could reach it. This is the counting.
 *
 * What is checked is the deciding, not the wording: that a thing is reported
 * once, that it is not reported again until it has recovered, and that a
 * device which goes away is forgotten rather than silently remembered.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const Alerts = Harness.requireXlet("./lib/alerts.js");

const State = UPowerGlib.DeviceState;

/* Everything switched on, with the applet's own defaults for the levels. */
function limits(overrides) {
    return Object.assign({
        lowBattery: true,
        peripheralBattery: true,
        lowLevel: 20,
        peripheralLevel: 15,
        criticalLevel: 7,
        highTemp: true,
        highTempCelsius: 90,
        tempUnit: "celsius",
    }, overrides || {});
}

function battery(percentage, overrides) {
    return Object.assign({
        path: "/org/freedesktop/UPower/devices/battery_BAT0",
        kind: UPowerGlib.DeviceKind.BATTERY,
        state: State.DISCHARGING,
        powerSupply: true,
        vendor: "", model: "BAT0",
        percentage: percentage,
    }, overrides || {});
}

function mouse(percentage, overrides) {
    return Object.assign({
        path: "/org/bluez/hci0/dev_98_47_44_F9_EE_B2",
        kind: UPowerGlib.DeviceKind.MOUSE,
        state: State.UNKNOWN,
        powerSupply: false,
        vendor: "", model: "MX Anywhere",
        percentage: percentage,
    }, overrides || {});
}

function reading(devices, celsius) {
    return { devices: devices, cpuTemperature: celsius === undefined ? null : celsius };
}

/* A policy plus the notifications it produced, in order. */
function policy() {
    let said = [];
    let alerts = new Alerts.AlertPolicy((urgent, title, body) => said.push({
        urgent: urgent, title: title, body: body,
    }));
    return { alerts: alerts, said: said };
}

var cases = {};

cases["a battery falling past the limit is reported once"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(25)]), limits());
    Harness.equal(each.said.length, 0, "above the limit, nothing to say");

    each.alerts.check(reading([battery(19)]), limits());
    Harness.equal(each.said.length, 1, "and now there is");
    Harness.equal(each.said[0].urgent, false, "low is not urgent");

    each.alerts.check(reading([battery(18)]), limits());
    each.alerts.check(reading([battery(17)]), limits());
    Harness.equal(each.said.length, 1, "the same news is not news three more times");
};

cases["a battery has to climb clear of the limit before it counts again"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(19)]), limits());
    Harness.equal(each.said.length, 1, "reported");

    /* Sitting on the limit is exactly where a charging cable being nudged puts
     * it, and without the hysteresis that alternates for as long as it sits. */
    each.alerts.check(reading([battery(21)]), limits());
    each.alerts.check(reading([battery(19)]), limits());
    Harness.equal(each.said.length, 1, "two points clear is not recovered");

    each.alerts.check(reading([battery(26)]), limits());
    each.alerts.check(reading([battery(19)]), limits());
    Harness.equal(each.said.length, 2, "five points clear is, so it can be reported again");
};

cases["critical is urgent, and is said even after low was"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(19)]), limits());
    each.alerts.check(reading([battery(6)]), limits());
    Harness.equal(each.said.length, 2, "the second one is worth saying on its own");
    Harness.equal(each.said[1].urgent, true, "and is the one that interrupts");

    each.alerts.check(reading([battery(5)]), limits());
    Harness.equal(each.said.length, 2, "but only once");
};

cases["a battery on the cable is not warned about"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(5, { state: State.CHARGING })]), limits());
    each.alerts.check(reading([battery(5, { state: State.FULLY_CHARGED })]), limits());
    Harness.equal(each.said.length, 0, "it is filling up, not running out");
};

cases["a device that goes away while low is forgotten"] = function () {
    /*
     * A headset switched off while low never climbs back above its limit, so
     * it used to keep its entry for the session and come back at the same
     * level to silence.
     */
    let each = policy();
    each.alerts.check(reading([mouse(10)]), limits());
    Harness.equal(each.said.length, 1, "reported while it was there");

    each.alerts.check(reading([]), limits());
    each.alerts.check(reading([mouse(10)]), limits());
    Harness.equal(each.said.length, 2, "and again when it came back still low");
};

cases["a peripheral is judged against its own limit"] = function () {
    /* A mouse at 18% wants new batteries this week; a laptop at 18% is about
     * to lose your work. */
    let each = policy();
    each.alerts.check(reading([mouse(18), battery(18)]), limits());
    Harness.equal(each.said.length, 1, "only the machine's own is low at 18");
    Harness.ok(each.said[0].body.indexOf("BAT0") >= 0, "the battery: " + each.said[0].body);

    each.alerts.check(reading([mouse(14), battery(18)]), limits());
    Harness.equal(each.said.length, 2, "and the mouse at 14 is");
};

cases["a peripheral never goes critical"] = function () {
    let each = policy();
    each.alerts.check(reading([mouse(2)]), limits());
    Harness.equal(each.said.length, 1, "one notification");
    Harness.equal(each.said[0].urgent, false,
                  "an empty mouse is not something to interrupt anybody for");
};

cases["a device that reports no level is not guessed at"] = function () {
    let each = policy();
    each.alerts.check(reading([mouse(null), battery(null)]), limits());
    Harness.equal(each.said.length, 0, "nothing was measured, so nothing is claimed");
};

cases["a switched off alert says nothing and remembers nothing"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(5)]), limits({ lowBattery: false }));
    Harness.equal(each.said.length, 0, "off");

    /* And having been off is not the same as having been reported: switching
     * it back on has to report the state it finds. */
    each.alerts.check(reading([battery(5)]), limits());
    Harness.equal(each.said.length, 1, "on again, and it says what it found");
};

cases["critical is kept under low, whatever the two settings say"] = function () {
    Harness.equal(Alerts.criticalBelow(7, 20), 7, "an ordinary pair is left alone");
    Harness.equal(Alerts.criticalBelow(30, 20), 19, "above low is brought under it");
    Harness.equal(Alerts.criticalBelow(20, 20), 19,
                  "and equal too, or low is reachable at no value at all");
    Harness.equal(Alerts.criticalBelow(3, 5), 3, "the bottom of both ranges needs no help");
    Harness.equal(Alerts.criticalBelow(1, 5), 1, "nor does the floor");
};

cases["a critical level set above low does not swallow the low warning"] = function () {
    /*
     * The two are independent spinbuttons whose ranges overlap - 1 to 30
     * against 5 to 50 - so this pair can be set in the settings window. Tested
     * critical first, a battery falling past both never reached the branch for
     * low, and the low level silently did nothing.
     */
    let each = policy();
    let wrong = limits({ lowLevel: 20, criticalLevel: Alerts.criticalBelow(30, 20) });

    each.alerts.check(reading([battery(20)]), wrong);
    Harness.equal(each.said.length, 1, "low still happens");
    Harness.equal(each.said[0].urgent, false, "and is still the gentle one");

    each.alerts.check(reading([battery(10)]), wrong);
    Harness.equal(each.said.length, 2, "and critical after it");
    Harness.equal(each.said[1].urgent, true, "as the urgent one");
};

cases["a temperature is reported once and recovers five degrees clear"] = function () {
    let each = policy();
    each.alerts.check(reading([], 89), limits());
    Harness.equal(each.said.length, 0, "under the limit");

    each.alerts.check(reading([], 91), limits());
    each.alerts.check(reading([], 95), limits());
    Harness.equal(each.said.length, 1, "over it, once");

    each.alerts.check(reading([], 86), limits());
    each.alerts.check(reading([], 91), limits());
    Harness.equal(each.said.length, 1, "four degrees down is not recovered");

    each.alerts.check(reading([], 84), limits());
    each.alerts.check(reading([], 91), limits());
    Harness.equal(each.said.length, 2, "five is");
};

cases["a machine that reports no temperature is not warned about"] = function () {
    let each = policy();
    each.alerts.check(reading([], null), limits());
    each.alerts.check(reading([]), limits({ highTemp: false }));
    Harness.equal(each.said.length, 0, "nothing to compare");
};
