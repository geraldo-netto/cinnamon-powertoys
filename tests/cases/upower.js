/*
 * What UPower's devices contribute to the sensor lists, and which of them are
 * listed at all.
 *
 * Everything else about lib/upower.js needs a system bus and is covered by
 * live.js, which skips itself where there is not one. These two parts do not:
 * each is a function of a device list. sensorReadings is the one path into the
 * menu's sensor list that does not come from lib/sensors.js - the menu
 * concatenates the two and groups the result without knowing which came from
 * where, so the two have to produce the same shape, which is exactly the sort
 * of agreement that rots silently. reportedDevices is what decides whether a
 * device gets a row.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const Format = Harness.requireXlet("./lib/format.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");
const UPower = Harness.requireXlet("./lib/upower.js");

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;

/* A UPower device with everything the readings look at, plus overrides. */
function device(overrides) {
    return Object.assign({
        path: "/org/freedesktop/UPower/devices/battery_BAT0",
        kind: 2,
        state: 2,
        vendor: "Sony",
        model: "BAT0",
        powerSupply: true,
        present: true,
        percentage: 62,
        energyRate: 11.2,
        temperature: 31.5,
    }, overrides || {});
}

var cases = {};

cases["a battery reports a temperature and a draw"] = function () {
    let readings = UPower.sensorReadings([device()]);
    Harness.equal(readings.temperatures.length, 1, "one temperature");
    Harness.equal(readings.powers.length, 1, "one power meter");
    Harness.equal(readings.temperatures[0].celsius, 31.5, "the temperature it reported");
    Harness.equal(readings.powers[0].watts, 11.2, "and the rate");
};

cases["a battery's readings are grouped under the battery"] = function () {
    let readings = UPower.sensorReadings([device()]);
    let temperature = readings.temperatures[0];
    let power = readings.powers[0];

    Harness.equal(temperature.group, power.group,
                  "one group per device, so the two sit together under one heading");
    Harness.equal(temperature.groupLabel, "Sony BAT0", "headed by what the device is called");
    Harness.equal(temperature.shortLabel, "Temperature",
                  "and the row says only what it measures, since the heading has the rest");
    Harness.equal(power.shortLabel, "Power", "likewise");
};

cases["two batteries are two groups"] = function () {
    let readings = UPower.sensorReadings([
        device(),
        device({ path: "/org/freedesktop/UPower/devices/battery_BAT1", model: "BAT1" }),
    ]);
    Harness.equal(readings.temperatures.length, 2, "both reported one");
    Harness.ok(readings.temperatures[0].group !== readings.temperatures[1].group,
               "and they are not run together under one heading");
};

cases["a peripheral contributes its temperature but not a draw"] = function () {
    let readings = UPower.sensorReadings([
        device({ powerSupply: false, model: "BW01", vendor: "" }),
    ]);
    Harness.equal(readings.temperatures.length, 1, "a headset that reports a temperature");
    Harness.equal(readings.powers.length, 0,
                  "but only a system battery's rate is the machine's power draw");
};

cases["a device that reports neither contributes nothing"] = function () {
    let readings = UPower.sensorReadings([device({ temperature: null, energyRate: null })]);
    Harness.deepEqual(readings, { temperatures: [], powers: [] }, "nothing to say");
};

cases["nothing at zero is taken as a reading"] = function () {
    /*
     * UPower has no "is present" beside Temperature: a device with no
     * thermometer publishes 0.0, and so would a battery that really was at
     * freezing. Every bluetooth peripheral on a desk reads 0.0, so trusting it
     * put a sensor group under a headset's name with one row in it saying the
     * headset was at 0 °C. The rare true reading is the one that has to go.
     */
    let cold = UPower.sensorReadings([device({ temperature: 0 })]);
    Harness.equal(cold.temperatures.length, 0, "not a temperature UPower can vouch for");

    let idle = UPower.sensorReadings([device({ energyRate: 0 })]);
    Harness.equal(idle.powers.length, 0,
                  "a battery at rest reports 0 W, and a row saying so is worse than no row");
};

cases["these readings carry what the sensor list reads off them"] = function () {
    /* The fields lib/sensors.js produces and the menu consumes, named here so
     * that adding one to the sensors and not to these fails rather than
     * quietly showing an undefined heading. */
    const WANTED = ["id", "measure", "kind", "label", "group", "groupLabel", "shortLabel"];
    let readings = UPower.sensorReadings([device()]);
    for (let reading of readings.temperatures.concat(readings.powers)) {
        for (let field of WANTED)
            Harness.ok(reading[field] !== undefined && reading[field] !== null,
                       reading.measure + " carries no " + field);
    }
};

cases["and carry no field nothing reads"] = function () {
    /*
     * The mirror of the case above, and it has already been earned: `charging`
     * was set on every battery power reading and read by nothing, for as long
     * as these readings have existed. The list above says the shape is at
     * least what the menu needs; this one says it is no more than that, which
     * is the half that rots quietly.
     */
    const ALLOWED = {
        temperature: ["id", "measure", "chip", "rawLabel", "kind", "label", "group",
                      "groupLabel", "shortLabel", "critical", "celsius"],
        power: ["id", "measure", "kind", "label", "group", "groupLabel", "shortLabel", "watts"],
    };
    let extra = [];
    let readings = UPower.sensorReadings([device()]);
    for (let reading of readings.temperatures.concat(readings.powers)) {
        for (let field in reading) {
            if (ALLOWED[reading.measure].indexOf(field) < 0)
                extra.push(reading.measure + "." + field);
        }
    }
    Harness.deepEqual(extra, [], "set here and read nowhere");
};

cases["a battery that is not fitted is not a battery at 0%"] = function () {
    /*
     * The case the two guards this replaced were written for and could not
     * reach. UPower publishes Percentage as a plain double, so an empty bay
     * reads 0.0 and not nothing, and both guards asked whether it was nothing.
     * A laptop with its battery out got a row saying 0%, and with no display
     * device composed it became the machine's own battery in the panel.
     */
    let out = UPower.reportedDevices([device({ present: false, percentage: 0, state: State.UNKNOWN })]);
    Harness.deepEqual(out, [], "IsPresent is the field that says so");

    let fitted = UPower.reportedDevices([device({ percentage: 0, state: State.EMPTY })]);
    Harness.equal(fitted.length, 1,
                  "a battery that really is flat still has a row, which is the whole difference");
};

cases["a device that says nothing at all is dropped"] = function () {
    /* What the second guard was for: a proxy that carries no properties
     * answers false to IsPresent as well, so one test covers both. */
    Harness.deepEqual(UPower.reportedDevices([{ path: "/x", kind: Kind.MOUSE }]), [],
                      "nothing to say about it and no row for it");
};

cases["the charger is reported elsewhere, not here"] = function () {
    let out = UPower.reportedDevices([device({ path: "/ac", kind: Kind.LINE_POWER }), device()]);
    Harness.equal(out.length, 1, "whether the cable is in is a different question");
    Harness.equal(out[0].kind, 2, "and the battery is what is left");
};

cases["the machine's own batteries come before what is plugged into it"] = function () {
    let out = UPower.reportedDevices([
        device({ path: "/mouse", kind: Kind.MOUSE, powerSupply: false }),
        device({ path: "/headset", kind: Kind.HEADSET, powerSupply: false }),
        device({ path: "/bat" }),
    ]);
    Harness.deepEqual(out.map(entry => entry.path), ["/bat", "/mouse", "/headset"],
                      "the system battery, then peripherals by kind");
};

cases["their kind is one the menu knows and keeps"] = function () {
    let readings = UPower.sensorReadings([device()]);
    Harness.equal(readings.temperatures[0].kind, "battery", "battery");
    Harness.equal(Sensors.isPrimaryKind("battery"), true,
                  "which survives the menu's default filter, or a laptop would never see it");
    Harness.equal(Format.measureName("temperature"), readings.temperatures[0].shortLabel,
                  "and the word is the one lib/sensors.js uses for the same thing");
};
