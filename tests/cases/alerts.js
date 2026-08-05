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
const Fuzz = imports.fuzz;
const UPowerGlib = imports.gi.UPowerGlib;

const Alerts = Harness.requireXlet("./lib/alerts.js");

const State = UPowerGlib.DeviceState;
const Level = UPowerGlib.DeviceLevel;

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
        batteryLevel: Level.NONE,
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
        batteryLevel: Level.NONE,
    }, overrides || {});
}

function reading(devices, celsius, overrides) {
    return Object.assign({
        devices: devices,
        upowerAvailable: true,
        bluezAvailable: true,
        selectedTemperature: celsius === undefined || celsius === null ? null : {
            id: "cpu-temperature",
            label: "Processor",
            celsius: celsius,
        },
    }, overrides || {});
}

/* A policy plus the notifications it produced, in order. */
function policy() {
    let said = [];
    let alerts = new Alerts.AlertPolicy((urgent, title, body) => {
        said.push({ urgent: urgent, title: title, body: body });
        return true;
    });
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

cases["a failed battery delivery is retried before it is latched"] = function () {
    let attempts = 0;
    let alerts = new Alerts.AlertPolicy(() => ++attempts > 1);

    alerts.check(reading([battery(10)]), limits());
    alerts.check(reading([battery(10)]), limits());
    alerts.check(reading([battery(10)]), limits());
    Harness.equal(attempts, 2, "failure retries once and success latches the alert");
};

cases["a throwing alert sink cannot suppress later devices"] = function () {
    let attempts = [];
    let alerts = new Alerts.AlertPolicy((urgent, title, body) => {
        attempts.push(body);
        if (body.indexOf("BAT0") >= 0)
            throw new Error("notification shell failed");
        return true;
    });
    let devices = [battery(10), mouse(10)];

    alerts.check(reading(devices), limits());
    Harness.equal(attempts.length, 2, "the second device is attempted in the same reading");
    alerts.check(reading(devices), limits());
    Harness.equal(attempts.length, 3, "only the undelivered device is retried later");
};

cases["a failed temperature delivery is retried"] = function () {
    let attempts = 0;
    let alerts = new Alerts.AlertPolicy(() => ++attempts > 1);

    alerts.check(reading([], 95), limits());
    alerts.check(reading([], 95), limits());
    alerts.check(reading([], 95), limits());
    Harness.equal(attempts, 2, "temperature state commits only after delivery");
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

    each.alerts.check(reading([], null, { upowerAvailable: false }), limits());
    each.alerts.check(reading([mouse(10)]), limits());
    Harness.equal(each.said.length, 2,
                  "BlueZ-confirmed absence is enough despite an unrelated UPower outage");
};

cases["a degraded inventory preserves its device alert latch"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(10)]), limits());
    Harness.equal(each.said.length, 1, "the initial low battery is reported");

    each.alerts.check(reading([], null, { upowerAvailable: false }), limits());
    each.alerts.check(reading([battery(10)]), limits());
    Harness.equal(each.said.length, 1,
                  "a UPower outage and recovery do not repeat the same alert");

    each.alerts.check(reading([]), limits());
    each.alerts.check(reading([battery(10)]), limits());
    Harness.equal(each.said.length, 2,
                  "a confirmed physical removal still rearms the alert");
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

cases["coarse battery levels have non-numeric alert semantics"] = function () {
    let each = policy();
    each.alerts.check(reading([battery(0, { batteryLevel: Level.LOW })]), limits());
    Harness.equal(each.said.length, 1, "low is reported regardless of the placeholder figure");
    Harness.ok(each.said[0].body.indexOf("Low") >= 0, "the level is named: " + each.said[0].body);
    Harness.equal(each.said[0].body.indexOf("0%"), -1, "no fake percentage is shown");

    each.alerts.check(reading([battery(0, { batteryLevel: Level.CRITICAL })]), limits());
    Harness.equal(each.said.length, 2, "critical is a distinct urgent transition");
    Harness.equal(each.said[1].urgent, true, "critical interrupts");

    each.alerts.check(reading([battery(0, { batteryLevel: Level.NORMAL })]), limits());
    each.alerts.check(reading([battery(0, { batteryLevel: Level.LOW })]), limits());
    Harness.equal(each.said.length, 3, "a normal coarse state recovers the alert");
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

cases["a missing temperature sample does not rearm a hot alert"] = function () {
    let each = policy();
    let enabled = limits();

    each.alerts.check(reading([], 90), enabled);
    each.alerts.check(reading([], null), enabled);
    each.alerts.check(reading([], 91), enabled);
    Harness.equal(each.said.length, 1,
                  "an unreadable poll is not evidence that the machine recovered");

    each.alerts.check(reading([], 70), enabled);
    each.alerts.check(reading([], 90), enabled);
    Harness.equal(each.said.length, 2, "a confirmed recovery still rearms it");
};

cases["a different hot sensor is identified and reported"] = function () {
    let each = policy();
    each.alerts.check({ devices: [], selectedTemperature: {
        id: "cpu", label: "Processor", celsius: 95,
    } }, limits());
    each.alerts.check({ devices: [], selectedTemperature: {
        id: "gpu", label: "Radeon RX 6600 edge", celsius: 95,
    } }, limits());

    Harness.equal(each.said.length, 2, "a new source is distinct news");
    Harness.equal(each.said[0].body, "Processor - 95.0 °C", "the CPU is named");
    Harness.equal(each.said[1].body, "Radeon RX 6600 edge - 95.0 °C", "the GPU is named");
};

cases["a level that never bound is left alone rather than clamped"] = function () {
    /*
     * A key missing from the schema binds to nothing and leaves its property
     * undefined, which _reportUnboundSettings says out loud at startup. What
     * must not happen in the meantime is arithmetic on it: clamping undefined
     * against a number answers NaN, and a limit of NaN is a comparison that is
     * false whichever way a battery is going - the alert that setting exists
     * for would never fire again, silently.
     */
    Harness.equal(Alerts.criticalBelow(undefined, 20), undefined,
                  "no critical level to clamp");
    Harness.equal(Alerts.criticalBelow(7, undefined), 7,
                  "nothing to clamp it against");
    Harness.equal(Alerts.criticalBelow(null, 20), null, "nor a null one");
    Harness.equal(Alerts.criticalBelow("7", 20), "7", "nor one that is not a number at all");
};

cases["the critical level is always somewhere a battery can reach"] = function () {
    /*
     * The two are spinbuttons on one axis with overlapping ranges - 1 to 30
     * against 5 to 50 - and nothing in the settings window stops critical
     * being set at or above low. Where it is, a battery falling past both is
     * tested against critical first and the low warning can never happen.
     *
     * So whatever the pair, what comes back has to be a level under the low
     * one and still above nought, or the clamp has moved the problem rather
     * than fixed it.
     */
    Fuzz.forAll({ what: "criticalBelow", runs: 500 },
                random => [random.between(-10, 60), random.between(-10, 60)],
                ([critical, low]) => {
                    let clamped = Fuzz.answers(() => Alerts.criticalBelow(critical, low));
                    if (typeof clamped !== "number" || !Number.isFinite(clamped))
                        throw new Error("answered " + String(clamped));
                    if (clamped < 1)
                        throw new Error("clamped to " + clamped + ", which no battery reports");
                    /* Raised only off the floor: the spinbutton's own range
                     * starts at 1, and a critical level of nought or less is
                     * a level no battery ever falls past. */
                    if (clamped > critical && critical >= 1)
                        throw new Error("raised " + critical + " to " + clamped);
                    if (clamped !== 1 && clamped > critical)
                        throw new Error("raised " + critical + " to " + clamped);
                    if (clamped >= low && low > 1)
                        throw new Error("left " + clamped + " at or above the low level " + low);
                });
};

cases["nothing a machine can report makes the policy throw"] = function () {
    /*
     * check() runs on every poll with whatever the machine said, and a throw
     * here is a poll that never finishes drawing. The devices it is handed
     * come from UPower and from BlueZ, both of which can answer with less than
     * this applet expects - a percentage that is not there, a state nobody has
     * seen, a path that is not a string.
     */
    let kinds = [UPowerGlib.DeviceKind.BATTERY, UPowerGlib.DeviceKind.MOUSE,
                 UPowerGlib.DeviceKind.HEADSET, 9999];
    let states = [State.DISCHARGING, State.CHARGING, State.UNKNOWN, State.FULLY_CHARGED, 9999];

    Fuzz.forAll({ what: "check", runs: 400 }, random => {
        let devices = [];
        let count = random.below(4);
        for (let i = 0; i < count; i++) {
            devices.push({
                /* One path per device. Both backends key their devices by an
                 * object path that is unique by construction, and the two
                 * lists are merged on the address inside it, so two rows
                 * carrying one path is not a machine this can meet - and what
                 * it would mean is not "the same device twice" but two
                 * different devices sharing one entry in the memory of what
                 * has already been said. */
                path: "/device/" + i,
                kind: random.pick(kinds),
                state: random.pick(states),
                powerSupply: random.chance(2),
                vendor: "", model: "thing",
                percentage: random.chance(4) ? Fuzz.value(random) : random.between(0, 100),
            });
        }
        return {
            data: reading(devices, random.chance(3) ? null : Fuzz.number(random)),
            limits: limits({
                lowLevel: random.between(0, 60),
                peripheralLevel: random.between(0, 60),
                criticalLevel: random.between(0, 60),
                highTempCelsius: random.between(-20, 200),
                lowBattery: random.chance(4) !== true,
                peripheralBattery: random.chance(4) !== true,
                highTemp: random.chance(4) !== true,
            }),
        };
    }, input => {
        let each = policy();
        Fuzz.answers(() => each.alerts.check(input.data, input.limits));
        /* And again with the same reading, which is what a poll does: nothing
         * has changed, so nothing more is worth saying. */
        let saidOnce = each.said.length;
        Fuzz.answers(() => each.alerts.check(input.data, input.limits));
        if (each.said.length !== saidOnce)
            throw new Error("said " + (each.said.length - saidOnce) +
                            " more things about a reading that had not changed");
        for (let said of each.said) {
            Fuzz.isText(said.title, "the title");
            Fuzz.isString(said.body, "the body");
        }
    });
};

cases["a device sitting exactly on its limit is not announced twice"] = function () {
    /*
     * The reason there is a hysteresis at all. A battery resting on the
     * threshold - which is where a laptop left plugged in at its charge limit
     * sits for days - would otherwise alternate between reported and forgotten
     * on every poll, and say so every time.
     */
    let each = policy();
    for (let i = 0; i < 20; i++)
        each.alerts.check(reading([battery(20)]), limits());
    Harness.equal(each.said.length, 1, "twenty polls on the limit, one notification");

    /* Climbing to the limit plus five is still not clear of it. */
    each.alerts.check(reading([battery(25)]), limits());
    each.alerts.check(reading([battery(20)]), limits());
    Harness.equal(each.said.length, 1, "and it has not recovered enough to be news again");

    each.alerts.check(reading([battery(26)]), limits());
    each.alerts.check(reading([battery(20)]), limits());
    Harness.equal(each.said.length, 2, "a point clear of the hysteresis, and it counts again");
};

cases["a temperature sitting exactly on its limit is not announced twice"] = function () {
    let each = policy();
    for (let i = 0; i < 20; i++)
        each.alerts.check(reading([], 90), limits());
    Harness.equal(each.said.length, 1, "twenty polls at ninety, one notification");

    each.alerts.check(reading([], 85), limits());
    each.alerts.check(reading([], 90), limits());
    Harness.equal(each.said.length, 1, "eighty-five is not clear of it");

    each.alerts.check(reading([], 84.9), limits());
    each.alerts.check(reading([], 90), limits());
    Harness.equal(each.said.length, 2, "and now it has cooled enough to be news again");
};

cases["what an alert says is the device and where it is"] = function () {
    /*
     * The body of the notification, which is the whole of what somebody sees:
     * a title that is the same every time, and this. A body naming the wrong
     * device, or naming it without saying how bad it is, is a notification
     * that has to be acted on by opening the menu - which is the thing it
     * exists to save.
     */
    let each = policy();
    each.alerts.check(reading([battery(7)]), limits());
    Harness.equal(each.said.length, 1, "exactly on the critical level is critical");
    Harness.equal(each.said[0].urgent, true, "and urgent");
    Harness.equal(each.said[0].title, "Battery critically low", "the title");
    Harness.equal(each.said[0].body, "BAT0 - 7%", "the device, and where it is");

    let low = policy();
    low.alerts.check(reading([battery(20)]), limits());
    Harness.equal(low.said[0].urgent, false, "low is not urgent");
    Harness.equal(low.said[0].title, "Battery low", "its own title");
    Harness.equal(low.said[0].body, "BAT0 - 20%", "and the same shape of body");

    let hot = policy();
    hot.alerts.check(reading([], 90), limits());
    Harness.equal(hot.said[0].title, "High temperature", "the temperature's title");
    Harness.equal(hot.said[0].body, "Processor - 90.0 °C",
                  "and its source with the reading, to the tenth the menu shows");

    let fahrenheit = policy();
    fahrenheit.alerts.check(reading([], 90), limits({ tempUnit: "fahrenheit" }));
    Harness.equal(fahrenheit.said[0].body, "Processor - 194.0 °F",
                  "in whichever unit is set");
};

cases["a temperature alert switched off says nothing at any temperature"] = function () {
    /*
     * The switch is read in the same breath as "is there a reading at all",
     * and the two are an either-or: off, or nothing to judge. Read as an
     * and-both, a machine with the alert switched off and a temperature to
     * report would be warned anyway - which is the one thing switching it off
     * is for.
     */
    let each = policy();
    for (let celsius of [90, 120, 200]) {
        each.alerts.check(reading([], celsius), limits({ highTemp: false }));
        Harness.deepEqual(each.said, [], "nothing said at " + celsius);
    }

    /* And it is not remembering it either, or the first reading after it is
     * switched back on would be silence. */
    each.alerts.check(reading([], 95), limits());
    Harness.equal(each.said.length, 1, "switched back on, and the machine is still hot");
};
