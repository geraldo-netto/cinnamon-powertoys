/*
 * The sysfs layer, against a captured /sys.
 *
 * Everything here runs with IO.setRoot() pointed at tests/fixtures, so none
 * of it depends on what hardware the machine running the tests happens to
 * have - which is the whole reason the root is a parameter.
 *
 * The fixture is a plausible machine: an AMD processor with three
 * temperatures, two disks whose chips have the same name, a graphics card
 * with a fan and a power meter, a thermal zone hwmon does not cover and one
 * it does, four RAPL domains, two cpufreq policies, a battery with a charge
 * limit and an ACPI platform profile.
 */

const Harness = imports.harness;

const IO = Harness.requireXlet("./lib/io.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");
const Cpu = Harness.requireXlet("./lib/cpu.js");
const PowerSupply = Harness.requireXlet("./lib/power-supply.js");

/* Runs body with the layer pointed at a fixture, and puts it back after. */
function on(machine, body) {
    IO.setRoot(Harness.fixture(machine));
    try {
        return body();
    } finally {
        IO.setRoot("");
    }
}

function byId(list, id) {
    return list.find(entry => entry.id === id) || null;
}

var cases = {};

/* ---------------------------------------------------------------- */
/* discovery                                                         */

cases["finds every hwmon and thermal sensor"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(found.temperatures.length, 7, "temperatures");
        Harness.equal(found.fans.length, 1, "fans");
        Harness.equal(found.powerMeters.length, 3, "power meters");
    });
};

cases["a label is used as it stands when it already names its chip"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp1").display,
                      "k10temp Tctl", "a label that does not repeat the chip is prefixed");
        Harness.equal(byId(found.powerMeters, "hwmon:hwmon3:power1").display,
                      "amdgpu", "an unlabelled lone sensor is just the chip");
    });
};

cases["two chips of the same name are told apart"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon2:temp1").display,
                      "drivetemp (sda)", "first disk");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon10:temp1").display,
                      "drivetemp (sdb)", "second disk");
    });
};

cases["a PCI slot loses its leading domain"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon3:temp1").identity,
                      "03:00.0", "0000:03:00.0 reads better without the domain");
    });
};

cases["hwmon10 sorts after hwmon2, not before it"] = function () {
    on("machine", function () {
        let names = IO.listDir("/sys/class/hwmon");
        Harness.equal(names.indexOf("hwmon2") < names.indexOf("hwmon10"), true,
                      "natural order, so hwmon2 comes first: " + names.join(","));
    });
};

cases["a chip is classified by its name"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp1").kind, "cpu", "k10temp");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon3:temp1").kind, "gpu", "amdgpu");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon2:temp1").kind, "disk", "drivetemp");
        Harness.equal(byId(found.temperatures, "thermal:thermal_zone0").kind, "board", "acpitz");
    });
};

cases["a critical point is read from crit, then from emergency"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp1").critical, 95, "temp1_crit");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp3").critical, 100,
                      "temp3 has only an emergency point");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon3:temp1").critical, null,
                      "the card offers neither");
    });
};

cases["a thermal zone is used only where hwmon has nothing"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.ok(byId(found.temperatures, "thermal:thermal_zone0"),
                   "acpitz is not a hwmon chip here, so it is kept");
        Harness.equal(byId(found.temperatures, "thermal:thermal_zone1"), null,
                      "k10temp is already covered by hwmon0, so the zone is dropped");
    });
};

cases["a thermal zone takes its limit from the critical trip point"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "thermal:thermal_zone0").critical, 105,
                      "the passive trip point at 80 is not the critical one");
    });
};

cases["the averaged power node wins over the instantaneous one"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        let meters = found.powerMeters.filter(m => m.id.indexOf("hwmon4") >= 0);
        Harness.equal(meters.length, 2, "power1 counted once, plus power2");
        Harness.equal(meters[0].path, "/sys/class/hwmon/hwmon4/power1_average",
                      "power1_input is skipped because power1_average exists");
    });
};

cases["a sensor carries no field nothing reads"] = function () {
    on("machine", function () {
        let sensor = byId(Sensors.discoverSensors().powerMeters, "hwmon:hwmon3:power1");
        Harness.equal(sensor.capPath, undefined,
                      "the cap node was discovered for a feature that was never written");
    });
};

/* ---------------------------------------------------------------- */
/* reading                                                           */

cases["a reading converts millidegrees and microwatts"] = function () {
    on("machine", function () {
        let readings = new Sensors.SensorSet().read();
        Harness.near(byId(readings.temperatures, "hwmon:hwmon0:temp1").celsius, 70.8, 0.001,
                     "70800 millidegrees");
        Harness.equal(byId(readings.fans, "hwmon:hwmon3:fan1").rpm, 1367, "fan");
        Harness.near(byId(readings.powers, "hwmon:hwmon3:power1").watts, 64, 0.001,
                     "64000000 microwatts");
    });
};

cases["a reading carries what it measures"] = function () {
    on("machine", function () {
        let readings = new Sensors.SensorSet().read();
        Harness.equal(byId(readings.temperatures, "hwmon:hwmon0:temp1").measure, "temperature", "temp");
        Harness.equal(byId(readings.fans, "hwmon:hwmon3:fan1").measure, "fan", "fan");
        Harness.equal(byId(readings.powers, "hwmon:hwmon3:power1").measure, "power", "power");
    });
};

/* ---------------------------------------------------------------- */
/* energy counters                                                   */

cases["only the top level RAPL domains may be summed"] = function () {
    on("machine", function () {
        let counters = Sensors.discoverEnergyCounters();
        Harness.equal(counters.length, 4, "two packages, a sub-domain and a dtpm node");
        Harness.equal(byId(counters, "rapl:intel-rapl:0").topLevel, true, "a package");
        Harness.equal(byId(counters, "rapl:intel-rapl:1").topLevel, true, "the other package");
        Harness.equal(byId(counters, "rapl:intel-rapl:0:0").topLevel, false,
                      "inside the first package, so adding it would count twice");
        Harness.equal(byId(counters, "rapl:dtpm:0").topLevel, false, "not a RAPL package at all");
    });
};

cases["one energy reading is not enough for a rate"] = function () {
    on("machine", function () {
        let meter = new Sensors.EnergyMeter(Sensors.discoverEnergyCounters()[0]);
        meter.sample(0);
        Harness.equal(meter.watts, null, "nothing to subtract from yet");
    });
};

cases["microjoules over microseconds is watts"] = function () {
    on("machine", function () {
        let counter = byId(Sensors.discoverEnergyCounters(), "rapl:intel-rapl:0");
        let meter = new Sensors.EnergyMeter(counter);
        /* The fixture reads 1000000 uJ. Pretend a second passed and the
         * counter advanced by 45 J: that is 45 W. */
        meter.sample(0);
        meter._lastValue = 1000000 - 45000000;
        meter.sample(1000000);
        Harness.near(meter.watts, 45, 0.0001, "45 J in one second");
    });
};

cases["a counter that wraps does not read as a negative"] = function () {
    on("machine", function () {
        let counter = byId(Sensors.discoverEnergyCounters(), "rapl:intel-rapl:0");
        let meter = new Sensors.EnergyMeter(counter);
        meter.sample(0);
        /* Just under the maximum, so the fixture's 1000000 is past the wrap. */
        meter._lastValue = counter.maxRange - 1000000;
        meter.sample(1000000);
        Harness.near(meter.watts, 2, 0.0001, "1 J before the wrap plus 1 J after");
    });
};

cases["no time between two readings gives no rate"] = function () {
    on("machine", function () {
        let meter = new Sensors.EnergyMeter(Sensors.discoverEnergyCounters()[0]);
        meter.sample(5000);
        meter.sample(5000);
        Harness.equal(meter.watts, null, "the same instant twice says nothing");
    });
};

cases["an unreadable counter forgets what it knew"] = function () {
    let counter = on("machine", () => Sensors.discoverEnergyCounters()[0]);
    let meter = new Sensors.EnergyMeter(counter);
    /* The root is back to the real machine, where that path does not exist. */
    IO.setRoot("/nonexistent");
    try {
        meter.sample(0);
        Harness.equal(meter.watts, null, "watts");
        Harness.equal(meter._lastValue, null, "and the previous value, so it starts over");
    } finally {
        IO.setRoot("");
    }
};

/* ---------------------------------------------------------------- */
/* the kind table                                                    */

cases["every kind has a label, and only two have no pattern"] = function () {
    let withoutPattern = Sensors.KINDS.filter(entry => !entry.pattern).map(entry => entry.kind);
    Harness.deepEqual(withoutPattern, ["package", "other"],
                      "package comes from the counters, other is the fallback");
    for (let entry of Sensors.KINDS)
        Harness.ok(entry.label, entry.kind + " has no label");
};

cases["the interesting kinds are the ones the menu keeps"] = function () {
    for (let kind of ["cpu", "gpu", "package", "battery"])
        Harness.equal(Sensors.isPrimaryKind(kind), true, kind);
    for (let kind of ["board", "disk", "network", "other", "nonsense"])
        Harness.equal(Sensors.isPrimaryKind(kind), false, kind);
};

cases["sensors sort by kind, then by name"] = function () {
    let list = [{ kind: "disk", label: "b" }, { kind: "cpu", label: "z" },
                { kind: "cpu", label: "a" }, { kind: "nonsense", label: "a" }];
    list.sort(Sensors.bySensorOrder);
    Harness.deepEqual(list.map(e => e.kind + ":" + e.label),
                      ["cpu:a", "cpu:z", "disk:b", "nonsense:a"], "order");
};

/* ---------------------------------------------------------------- */
/* cpufreq                                                           */

cases["the scaling interface is read from the first policy"] = function () {
    on("machine", function () {
        let cpu = new Cpu.CpuControl();
        Harness.equal(cpu.available, true, "available");
        Harness.equal(cpu.driver, "amd-pstate-epp", "driver");
        Harness.equal(cpu.governor, "powersave", "governor");
        Harness.deepEqual(cpu.governors, ["performance", "powersave"], "governors");
        Harness.equal(cpu.energyPreference, "power", "energy preference");
        Harness.equal(cpu.amdPstateStatus, "active", "amd_pstate status");
    });
};

cases["the frequency is averaged across every policy"] = function () {
    on("machine", function () {
        let cpu = new Cpu.CpuControl();
        Harness.near(cpu.snapshot().averageFrequency, 3500, 0.001, "3000 and 4000 MHz");
        Harness.near(cpu.maxFrequency(), 5462.711, 0.001, "max");
    });
};

cases["a boost switch is read the right way round"] = function () {
    on("machine", function () {
        let cpu = new Cpu.CpuControl();
        Harness.equal(cpu.boostSupported, true, "cpufreq/boost exists");
        Harness.equal(cpu.boostInverted, false, "and means what it says");
        Harness.equal(cpu.boostEnabled, true, "1 is on");
    });
    on("inverted-boost", function () {
        let cpu = new Cpu.CpuControl();
        Harness.equal(cpu.boostSupported, true, "intel_pstate/no_turbo exists");
        Harness.equal(cpu.boostInverted, true, "and means the opposite");
        Harness.equal(cpu.boostEnabled, true, "no_turbo 0 is boost on");
    });
};

cases["a setting is written through the runner it was given"] = function () {
    on("machine", function () {
        let sent = [];
        let cpu = new Cpu.CpuControl(args => sent.push(args.join(" ")));
        cpu.setGovernor("performance");
        cpu.setEnergyPreference("power");
        cpu.setBoost(true);
        cpu.setBoost(false);
        Harness.deepEqual(sent, ["governor performance", "epp power", "boost 1", "boost 0"],
                          "the helper's own vocabulary");
    });
};

/* ---------------------------------------------------------------- */
/* power supply                                                      */

cases["the charge limit is found on the battery that has one"] = function () {
    on("machine", function () {
        let control = PowerSupply.discoverChargeControl();
        Harness.ok(control, "not found");
        Harness.equal(control.battery, "BAT0", "the mains entry is not a battery");
        Harness.equal(control.path, "/sys/class/power_supply/BAT0/charge_control_end_threshold", "path");
    });
};

cases["the platform profile reads its own choices"] = function () {
    on("machine", function () {
        let profile = PowerSupply.platformProfile();
        Harness.equal(profile.active, "balanced", "active");
        Harness.deepEqual(profile.choices, ["quiet", "balanced", "performance"], "choices");
    });
};

cases["a machine with none of it answers null rather than throwing"] = function () {
    IO.setRoot("/nonexistent");
    try {
        Harness.equal(PowerSupply.discoverChargeControl(), null, "charge control");
        Harness.equal(PowerSupply.platformProfile(), null, "platform profile");
        Harness.equal(new Cpu.CpuControl().available, false, "cpufreq");
        let found = Sensors.discoverSensors();
        Harness.equal(found.temperatures.length, 0, "temperatures");
    } finally {
        IO.setRoot("");
    }
};

cases["naming leaves the entries it was given alone"] = function () {
    on("machine", function () {
        let raw = [{ chip: "drivetemp", rawLabel: null, siblings: 1, index: "1",
                     identity: "sda", measure: "temperature" },
                   { chip: "drivetemp", rawLabel: null, siblings: 1, index: "1",
                     identity: "sdb", measure: "temperature" }];
        let named = Sensors._finalizeNames(raw);
        Harness.equal(raw[0].display, undefined, "the input was mutated");
        Harness.equal(named[0].display, "drivetemp (sda)", "first");
        Harness.equal(named[1].display, "drivetemp (sdb)", "second");
    });
};

cases["a fan and a meter on one chip are not disambiguated against each other"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.fans, "hwmon:hwmon3:fan1").display, "amdgpu",
                      "the card's only fan");
        Harness.equal(byId(found.powerMeters, "hwmon:hwmon3:power1").display, "amdgpu",
                      "and its only meter, told apart by RPM against watts");
    });
};

cases["a sensor is matched on what the driver calls it"] = function () {
    let tctl = { chip: "k10temp", rawLabel: "Tctl", display: "k10temp Tctl" };
    let zone = { chip: "cpu_thermal", rawLabel: null, display: "cpu_thermal" };
    Harness.equal(Sensors.sensorMatches(tctl, "tctl"), true, "its label");
    Harness.equal(Sensors.sensorMatches(tctl, "K10TEMP"), true, "its chip, any case");
    Harness.equal(Sensors.sensorMatches(zone, "cpu"), true, "a zone has only a type");
    Harness.equal(Sensors.sensorMatches(tctl, "k10temp tctl"), false,
                  "the composed menu name is not what is compared");
    Harness.equal(Sensors.sensorMatches(tctl, ""), false, "an empty hint matches nothing");
};

cases["a reading carries the driver's own label"] = function () {
    on("machine", function () {
        let readings = new Sensors.SensorSet().read();
        Harness.equal(byId(readings.temperatures, "hwmon:hwmon0:temp1").rawLabel, "Tctl", "labelled");
        Harness.equal(byId(readings.temperatures, "thermal:thermal_zone0").rawLabel, null,
                      "a zone has none");
    });
};

cases["the charge limit is read fresh, not remembered"] = function () {
    on("machine", function () {
        let control = PowerSupply.discoverChargeControl();
        Harness.equal(control.limit, 80, "as the fixture has it");
        IO.setRoot("/nonexistent");
        Harness.equal(control.limit, null, "and it notices when the node goes away");
    });
};

cases["a charge limit is written through the runner"] = function () {
    on("machine", function () {
        let sent = [];
        let control = PowerSupply.discoverChargeControl(args => sent.push(args.join(" ")));
        control.setLimit(80);
        Harness.deepEqual(sent, ["charge-threshold 80"], "the helper's own vocabulary");
    });
};
