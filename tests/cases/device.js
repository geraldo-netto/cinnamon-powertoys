/*
 * What a powered device says about itself.
 *
 * These used to be methods on the applet and could not be reached without one
 * running. They are functions of a device and two numbers now, so a case can
 * simply hand over a device.
 */

const Harness = imports.harness;

const Device = Harness.requireXlet("./lib/device.js");
const UPowerGlib = imports.gi.UPowerGlib;

const State = UPowerGlib.DeviceState;
const Kind = UPowerGlib.DeviceKind;
const Level = UPowerGlib.DeviceLevel;

function battery(extra) {
    let device = { path: "/bat", powerSupply: true, kind: Kind.BATTERY,
                   state: State.DISCHARGING, vendor: "ACME", model: "BAT0",
                   percentage: 42, batteryLevel: Level.NONE, icon: "battery-good-symbolic",
                   energyRate: 0, voltage: 0, temperature: 0, capacity: 0, cycles: 0,
                   energy: 0, energyFull: 0, timeToEmpty: 0, timeToFull: 0 };
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

cases["a full battery says everything it knows"] = function () {
    let device = battery({ state: State.DISCHARGING, timeToEmpty: 5400, energyRate: 11.5,
                           voltage: 11.1, temperature: 31.5, capacity: 92, cycles: 140,
                           energy: 40, energyFull: 50 });
    Harness.equal(Device.describe(device, "celsius"),
                  "Discharging · 1h 30m remaining · 12 W · 11.10 V · 31.5 °C · " +
                  "health 92% · 140 cycles · 40.0 Wh / 50.0 Wh", "celsius");
    Harness.equal(Device.describe(device, "fahrenheit").indexOf("88.7 °F") >= 0, true,
                  "the unit reaches the temperature");
};

cases["a device that reports nothing says what it is"] = function () {
    Harness.equal(Device.describe(mouse(), "celsius"), "Mouse",
                  "better than the word Unknown");
};

cases["a healthy battery does not mention its health"] = function () {
    Harness.equal(Device.describe(battery({ capacity: 100 }), "celsius").indexOf("health"), -1,
                  "100% health is not news");
    Harness.equal(Device.describe(battery({ capacity: 92 }), "celsius").indexOf("health 92%") >= 0,
                  true, "92% is");
};

cases["nothing empty is left in the sentence"] = function () {
    let text = Device.describe(battery({ state: State.CHARGING }), "celsius");
    Harness.equal(text, "Charging", "no stray separators");
    Harness.equal(text.indexOf("··"), -1, "and none doubled");
};
