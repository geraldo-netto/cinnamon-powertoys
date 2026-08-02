/*
 * What UPower's devices contribute to the sensor lists.
 *
 * Everything else about lib/upower.js needs a system bus and is covered by
 * live.js, which skips itself where there is not one. This part does not: it
 * is a function of a device list, and it is the one path into the menu's
 * sensor list that does not come from lib/sensors.js. The menu concatenates
 * the two and groups the result without knowing which came from where, so the
 * two have to produce the same shape - which is exactly the sort of agreement
 * that rots silently.
 */

const Harness = imports.harness;

const Format = Harness.requireXlet("./lib/format.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");
const UPower = Harness.requireXlet("./lib/upower.js");

/* A UPower device with everything the readings look at, plus overrides. */
function device(overrides) {
    return Object.assign({
        path: "/org/freedesktop/UPower/devices/battery_BAT0",
        kind: 2,
        state: 2,
        vendor: "Sony",
        model: "BAT0",
        powerSupply: true,
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

cases["their kind is one the menu knows and keeps"] = function () {
    let readings = UPower.sensorReadings([device()]);
    Harness.equal(readings.temperatures[0].kind, "battery", "battery");
    Harness.equal(Sensors.isPrimaryKind("battery"), true,
                  "which survives the menu's default filter, or a laptop would never see it");
    Harness.equal(Format.measureName("temperature"), readings.temperatures[0].shortLabel,
                  "and the word is the one lib/sensors.js uses for the same thing");
};
