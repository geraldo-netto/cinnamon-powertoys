/*
 * What a powered device says about itself.
 *
 * These used to be methods on the applet and could not be reached without one
 * running. They are functions of a device and two numbers now, so a case can
 * simply hand over a device.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Device = Harness.requireXlet("./lib/device.js");
const UPowerGlib = imports.gi.UPowerGlib;

const State = UPowerGlib.DeviceState;
const Kind = UPowerGlib.DeviceKind;
const Level = UPowerGlib.DeviceLevel;

/*
 * The optional fields are null and not zero, which is what UPower's own
 * _number() produces for a property a device does not have. They were zero
 * here, and that is the difference between "does not report a temperature"
 * and "is at freezing" - a distinction the code could not make either, until
 * it had to.
 */
function battery(extra) {
    let device = { path: "/bat", powerSupply: true, kind: Kind.BATTERY,
                   state: State.DISCHARGING, vendor: "ACME", model: "BAT0",
                   percentage: 42, batteryLevel: Level.NONE, icon: "battery-good-symbolic",
                   energyRate: null, voltage: null, temperature: null, capacity: null,
                   cycles: null, energy: null, energyFull: null,
                   timeToEmpty: null, timeToFull: null };
    for (let key in extra || {})
        device[key] = extra[key];
    return device;
}

function mouse(extra) {
    let device = battery();
    device.path = "/mouse";
    device.powerSupply = false;
    device.kind = Kind.MOUSE;
    device.state = State.UNKNOWN;
    device.model = "MX";
    /* after the peripheral defaults, so a case can still set the state */
    for (let key in extra || {})
        device[key] = extra[key];
    return device;
}

var cases = {};

/* ---------------------------------------------------------------- */
/* draining                                                          */

cases["a system battery is draining only when it says so"] = function () {
    Harness.equal(Device.isDraining(battery({ state: State.DISCHARGING })), true, "discharging");
    Harness.equal(Device.isDraining(battery({ state: State.CHARGING })), false, "charging");
    Harness.equal(Device.isDraining(battery({ state: State.FULLY_CHARGED })), false, "full");
    Harness.equal(Device.isDraining(battery({ state: State.UNKNOWN })), false,
                  "a system battery reporting nothing is not assumed to be draining");
};

cases["a peripheral is draining unless it says it is charging"] = function () {
    Harness.equal(Device.isDraining(mouse({ state: State.UNKNOWN })), true,
                  "which is what almost every peripheral reports");
    Harness.equal(Device.isDraining(mouse({ state: State.CHARGING })), false, "charging");
    Harness.equal(Device.isDraining(mouse({ state: State.FULLY_CHARGED })), false, "full");
    Harness.equal(Device.isDraining(mouse({ state: State.PENDING_CHARGE })), false, "on the dock");
};

cases["a peripheral has its own low level"] = function () {
    Harness.equal(Device.lowThreshold(battery(), 20, 15), 20, "system");
    Harness.equal(Device.lowThreshold(mouse(), 20, 15), 15, "peripheral");
};

cases["warning recovery respects precise hysteresis and coarse levels"] = function () {
    Harness.equal(Device.chargeRecovered(battery({ percentage: 24 }), 20, 5), false,
                  "a precise battery inside the hysteresis remains warned");
    Harness.equal(Device.chargeRecovered(battery({ percentage: 26 }), 20, 5), true,
                  "a precise battery clears beyond the hysteresis");
    Harness.equal(Device.chargeRecovered(battery({ percentage: 0, batteryLevel: Level.LOW }),
                                         20, 5), false,
                  "a coarse low state remains warned");
    for (let level of [Level.NORMAL, Level.HIGH, Level.FULL])
        Harness.equal(Device.chargeRecovered(battery({ percentage: 0, batteryLevel: level }),
                                             20, 5), true,
                      "coarse recovery level " + level + " clears the warning");
};

/* ---------------------------------------------------------------- */
/* time remaining                                                    */

cases["time remaining is shown for the direction it is going"] = function () {
    Harness.equal(Device.remainingText(battery({ state: State.DISCHARGING, timeToEmpty: 5400 })),
                  "1h 30m remaining", "discharging");
    Harness.equal(Device.remainingText(battery({ state: State.CHARGING, timeToFull: 2700 })),
                  "45m until full", "charging");
    Harness.equal(Device.remainingText(battery({ state: State.DISCHARGING, timeToFull: 2700 })),
                  "", "the wrong estimate for the direction is not shown");
    Harness.equal(Device.remainingText(battery({ state: State.DISCHARGING, timeToEmpty: 0 })),
                  "", "no estimate at all");
};

/* ---------------------------------------------------------------- */
/* the sentence under the name                                       */

cases["a full battery says its status and health"] = function () {
    let device = battery({ state: State.DISCHARGING, timeToEmpty: 5400, energyRate: 11.5,
                           voltage: 11.1, temperature: 31.5, capacity: 92, cycles: 140,
                           energy: 40, energyFull: 50 });
    Harness.equal(Device.describe(device),
                  "Discharging · 1h 30m remaining · 11.10 V · " +
                  "health 92% · 140 cycles · 40.0 Wh / 50.0 Wh", "status details");
};

cases["a device that reports nothing says what it is"] = function () {
    Harness.equal(Device.describe(mouse()), "Mouse",
                  "better than the word Unknown");
};

cases["live measurements are owned by Sensors rather than device status"] = function () {
    let details = Device.describe(battery({ energyRate: 11.5, temperature: 31.5, voltage: 0 }));
    Harness.equal(details.indexOf("W"), -1, "consumption is not duplicated under Devices");
    Harness.equal(details.indexOf("°C"), -1, "temperature is not duplicated under Devices");
    Harness.equal(details.indexOf("V"), -1, "and 0 V is a battery that is not reporting");
};

cases["a healthy battery does not mention its health"] = function () {
    Harness.equal(Device.describe(battery({ capacity: 100 })).indexOf("health"), -1,
                  "100% health is not news");
    Harness.equal(Device.describe(battery({ capacity: 92 })).indexOf("health 92%") >= 0,
                  true, "92% is");
};

cases["nothing empty is left in the sentence"] = function () {
    let text = Device.describe(battery({ state: State.CHARGING }));
    Harness.equal(text, "Charging", "no stray separators");
    Harness.equal(text.indexOf("··"), -1, "and none doubled");
};

cases["an empty device group distinguishes absence from unavailable status"] = function () {
    Harness.equal(Device.emptyStatus({
        lines: [], devices: [], upowerAvailable: true, chargeLimitAvailable: false,
    }), "Nothing with a battery is connected", "UPower confirmed the genuinely empty case");
    Harness.equal(Device.emptyStatus({
        lines: [], devices: [], upowerAvailable: false, chargeLimitAvailable: false,
    }), "Device status is unavailable", "an unavailable backend makes no absence claim");
    Harness.equal(Device.emptyStatus({
        lines: [], devices: [], upowerAvailable: false, chargeLimitAvailable: true,
    }), "A battery is present, but its status is unavailable",
    "sysfs evidence names the known battery without inventing its status");
    Harness.equal(Device.emptyStatus({
        lines: [], devices: [], upowerAvailable: true, chargeLimitAvailable: true,
    }), "A battery is present, but its status is unavailable",
    "independent battery evidence wins over an empty UPower device list");
    Harness.equal(Device.emptyStatus({
        lines: [], devices: [battery()], upowerAvailable: false, chargeLimitAvailable: false,
    }), "", "a row leaves no empty-state message beside it");
};

/* ---------------------------------------------------------------- */
/* what a row is told to show                                        */

const OPTIONS = { tempUnit: "celsius", lowLevel: 20, peripheralLevel: 15 };

cases["a row is given everything it needs and no rules"] = function () {
    let model = Device.viewModel(battery({ percentage: 42 }), OPTIONS);
    Harness.deepEqual(Object.keys(model).sort(),
                      ["details", "icon", "key", "title", "warning"], "the whole model");
    Harness.equal(model.key, "/bat", "keyed by path");
    Harness.equal(model.title, "ACME BAT0  42%", "title");
};

cases["a coarse level is shown as a level, not as a number"] = function () {
    Harness.equal(Device.viewModel(mouse({ percentage: 55, batteryLevel: Level.LOW }), OPTIONS).title,
                  "ACME MX  Low", "a device that cannot really measure");
    Harness.equal(Device.viewModel(mouse({ percentage: 55, batteryLevel: Level.NONE }), OPTIONS).title,
                  "ACME MX  55%", "one that can");
};

cases["a battery keeps UPower's icon, a peripheral gets one for what it is"] = function () {
    Harness.equal(Device.viewModel(battery({ icon: "battery-good-symbolic" }), OPTIONS).icon,
                  "battery-good", "the level is in that name, so it is kept");
    Harness.equal(Device.viewModel(mouse(), OPTIONS).icon, "xsi-input-mouse",
                  "UPower says battery-missing for a mouse, which helps nobody");
};

cases["the warning follows the limit that applies to the device"] = function () {
    Harness.equal(Device.viewModel(battery({ percentage: 21 }), OPTIONS).warning, false, "21 of 20");
    Harness.equal(Device.viewModel(battery({ percentage: 20 }), OPTIONS).warning, true, "20 of 20");
    Harness.equal(Device.viewModel(mouse({ percentage: 18 }), OPTIONS).warning, false,
                  "18 is fine for a mouse, whose limit is 15");
    Harness.equal(Device.viewModel(mouse({ percentage: 15 }), OPTIONS).warning, true, "15 of 15");
    Harness.equal(Device.viewModel(battery({ percentage: 0, batteryLevel: Level.LOW }), OPTIONS).warning,
                  true, "a coarse low battery is low without inventing a percentage");
    Harness.equal(Device.viewModel(battery({ percentage: 0, batteryLevel: Level.NORMAL }), OPTIONS).warning,
                  false, "a coarse normal battery ignores the placeholder zero");
};

cases["a device that is charging is never warned about"] = function () {
    Harness.equal(Device.viewModel(battery({ percentage: 5, state: State.CHARGING }), OPTIONS).warning,
                  false, "on the cable at 5%");
    Harness.equal(Device.viewModel(battery({ percentage: 5, state: State.DISCHARGING }), OPTIONS).warning,
                  true, "off it at 5%");
};

cases["a device with no percentage is never warned about"] = function () {
    Harness.equal(Device.viewModel(battery({ percentage: null }), OPTIONS).warning, false,
                  "nothing to compare");
};

/* ---------------------------------------------------------------- */
/* whatever a device says about itself                               */

cases["a device exactly on its limit is warned about"] = function () {
    /*
     * The boundary is where a warning is worth anything: a mouse that has been
     * sitting at fifteen percent for a week is exactly what the peripheral
     * level was set for, and a comparison that excluded its own value would
     * wait for fourteen - which on a device that reports in steps of five may
     * never come.
     */
    let options = { tempUnit: "celsius", lowLevel: 20, peripheralLevel: 15 };
    Harness.equal(Device.viewModel(battery({ percentage: 20 }), options).warning, true,
                  "a battery exactly on the low level");
    Harness.equal(Device.viewModel(battery({ percentage: 21 }), options).warning, false,
                  "and one point above it");
    Harness.equal(Device.viewModel(mouse({ percentage: 15 }), options).warning, true,
                  "a peripheral exactly on its own");
    Harness.equal(Device.viewModel(mouse({ percentage: 16 }), options).warning, false,
                  "and one point above that");
    Harness.equal(Device.viewModel(mouse({ percentage: 20 }), options).warning, false,
                  "a peripheral is not judged against the battery's level");
};

cases["a row is three strings and a flag, whatever the device reported"] = function () {
    /*
     * A device row is drawn straight from this: the title into a label, the
     * details into another, the icon name into St, the flag into a style
     * class. UPower hands out what the hardware said, which on a bluetooth
     * peripheral is a subset of what a laptop battery reports and on a broken
     * one is anybody's guess.
     */
    let kinds = [Kind.BATTERY, Kind.MOUSE, Kind.KEYBOARD, Kind.HEADSET, Kind.UPS, 9999];
    let states = [State.DISCHARGING, State.CHARGING, State.UNKNOWN, State.FULLY_CHARGED,
                  State.PENDING_CHARGE, State.EMPTY, 9999];
    let levels = [Level.NONE, Level.LOW, Level.CRITICAL, Level.FULL, 9999];

    Fuzz.forAll({ what: "viewModel", runs: 500 }, random => ({
        device: {
            path: "/device",
            powerSupply: random.chance(2),
            kind: random.pick(kinds),
            state: random.pick(states),
            batteryLevel: random.pick(levels),
            vendor: random.chance(3) ? "" : Fuzz.text(random, 3),
            model: random.chance(3) ? "" : Fuzz.text(random, 3),
            icon: random.chance(3) ? "" : "battery-good-symbolic",
            percentage: random.chance(4) ? Fuzz.value(random) : random.between(0, 100),
            energyRate: random.chance(3) ? null : Fuzz.number(random),
            voltage: random.chance(3) ? null : Fuzz.number(random),
            temperature: random.chance(3) ? null : Fuzz.number(random),
            capacity: random.chance(3) ? null : Fuzz.number(random),
            cycles: random.chance(3) ? null : Fuzz.number(random),
            energy: random.chance(3) ? null : Fuzz.number(random),
            energyFull: random.chance(3) ? null : Fuzz.number(random),
            timeToEmpty: random.chance(3) ? null : Fuzz.number(random),
            timeToFull: random.chance(3) ? null : Fuzz.number(random),
        },
        options: { tempUnit: random.chance(2) ? "celsius" : "fahrenheit",
                   lowLevel: random.between(0, 60), peripheralLevel: random.between(0, 60) },
    }), input => {
        let model = Fuzz.answers(() => Device.viewModel(input.device, input.options));
        Fuzz.isString(model.title, "the title");
        Fuzz.isString(model.details, "the details");
        Fuzz.isString(model.icon, "the icon name");
        if (typeof model.warning !== "boolean")
            throw new Error("the warning flag is " + String(model.warning));
        if (model.title.length === 0)
            throw new Error("a row with no title at all");
        /* The details are joined with a separator, and an empty part either
         * side of it is a row that reads as though something is missing. */
        if (/(^ · | · $|· ·)/.test(model.details))
            throw new Error("an empty part in the details: " + JSON.stringify(model.details));
    });
};

cases["a device with nothing to report still gets a row"] = function () {
    /* A bluetooth mouse that has just connected reports a percentage and
     * nothing else at all, and it is still a device somebody wants to see. */
    let bare = { path: "/x", powerSupply: false, kind: Kind.MOUSE, state: State.UNKNOWN,
                 batteryLevel: Level.NONE, vendor: "", model: "", icon: "",
                 percentage: 55, energyRate: null, voltage: null, temperature: null,
                 capacity: null, cycles: null, energy: null, energyFull: null,
                 timeToEmpty: null, timeToFull: null };
    let model = Device.viewModel(bare, { tempUnit: "celsius", lowLevel: 20, peripheralLevel: 15 });
    Harness.equal(model.title, "Mouse  55%", "named for what it is, and how full");
    Harness.equal(model.details, "Mouse", "and the one thing left to say about it");
    Harness.equal(model.warning, false, "at fifty-five it is not low");
};

cases["a figure is only shown where the device really reported one"] = function () {
    /*
     * Each of these is guarded twice - is there a value, and is it a value
     * worth showing - and the two are not the same question. UPower publishes
     * a plain number with nothing beside it to say whether the hardware
     * measured it, so nought is both "none fitted" and a real reading
     * depending on the field, and a battery whose firmware answers -1 is a
     * battery this has to survive rather than repeat.
     */
    let options = { tempUnit: "celsius", lowLevel: 20, peripheralLevel: 15 };
    let details = extra => Device.viewModel(battery(extra), options).details;

    Harness.ok(details({ cycles: 1 }).indexOf("1 cycles") >= 0,
               "one charge cycle is a cycle: " + details({ cycles: 1 }));
    Harness.equal(details({ cycles: 0 }).indexOf("cycles"), -1,
                  "and none at all is a battery that does not count them");
    Harness.equal(details({ cycles: -3 }).indexOf("cycles"), -1,
                  "nor is a count below nothing, which is firmware talking nonsense");

    Harness.ok(details({ energy: 30, energyFull: 50 }).indexOf("30.0 Wh / 50.0 Wh") >= 0,
               "both halves of the charge, as a fraction");
    Harness.equal(details({ energy: 30, energyFull: null }).indexOf("Wh"), -1,
                  "one half is not a fraction, and half a fraction is not a row");
    Harness.equal(details({ energy: null, energyFull: 50 }).indexOf("Wh"), -1,
                  "the other way round either");

    Harness.ok(details({ capacity: 87 }).indexOf("health 87%") >= 0, "health worth saying");
    Harness.equal(details({ capacity: 100 }).indexOf("health"), -1,
                  "a battery at full health does not need telling");
    Harness.equal(details({ capacity: 0 }).indexOf("health"), -1,
                  "and one reporting nothing is not at nought percent health");
};
