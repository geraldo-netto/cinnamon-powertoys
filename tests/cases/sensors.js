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

const Hardware = Harness.requireXlet("./lib/hardware.js");
const IO = Harness.requireXlet("./lib/io.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");
const Cpu = Harness.requireXlet("./lib/cpu.js");
const PowerSupply = Harness.requireXlet("./lib/power-supply.js");

/*
 * Runs body with the layer pointed at a fixture, and puts it back after.
 *
 * The hardware names are cached, because a PCI address does not change what it
 * means while the applet runs - but the machine underneath does change here,
 * between one case and the next, so the cache is dropped on the way in and on
 * the way out.
 */
function on(machine, body) {
    Hardware.forget();
    IO.setRoot(Harness.fixture(machine));
    try {
        return body();
    } finally {
        IO.setRoot("");
        Hardware.forget();
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
        Harness.equal(found.temperatures.length, 8, "temperatures");
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

cases["a group is named after the hardware, not after where it is plugged in"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp1").groupLabel,
                      "AMD Ryzen 7 5800X", "the processor comes from /proc/cpuinfo");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon3:temp1").groupLabel,
                      "Radeon RX 6600/6600 XT/6600M",
                      "the card comes from pci.ids, by way of its device id");
        Harness.equal(byId(found.powerMeters, "hwmon:hwmon4:power1").groupLabel,
                      "nct6798", "a chip on neither keeps the driver's own name");
    });
};

cases["two chips with the same name make two groups, told apart"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon2:temp1").group,
                      "hwmon:hwmon2", "one group per chip");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon2:temp1").groupLabel,
                      "drivetemp (sda)", "first disk");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon10:temp1").groupLabel,
                      "drivetemp (sdb)", "second disk");
    });
};

cases["a row under a named group drops the chip and the address"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp1").short,
                      "Cooling control (Tctl)",
                      "a control value, said in words, with the driver's word to match on");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp2").short,
                      "Core die 1 (Tccd1)", "an abbreviation nobody outside the driver reads");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon3:temp1").short,
                      "Die edge", "the card's, whose one word the driver writes in lower case");
        Harness.equal(byId(found.fans, "hwmon:hwmon3:fan1").short,
                      "Fan", "a reading the driver never labelled");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon2:temp1").short,
                      "Temperature", "and the disks, whose chips are told apart by the group");
    });
};

cases["a tidied label is text, not a replacement pattern"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        /* Tccd1 uses both what the pattern matched and the number in it. If
         * these were replacement strings a translation containing $ would be
         * eaten by String.replace, so the table answers with a name instead. */
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp2").short,
                      "Core die 1 (Tccd1)", "first");
        Harness.equal(byId(found.temperatures, "hwmon:hwmon0:temp3").short,
                      "Core die 2 (Tccd2)", "second");
    });
};

cases["everything one chip says stays together, in kind order"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        let sorted = found.temperatures.concat(found.fans, found.powerMeters)
            .sort(Sensors.bySensorOrder)
            .map(entry => entry.group);
        let seen = [];
        for (let group of sorted) {
            if (seen[seen.length - 1] !== group)
                seen.push(group);
        }
        Harness.equal(seen.length, new Set(seen).size,
                      "no group is left and come back to: " + seen.join(","));
        Harness.equal(seen[0], "hwmon:hwmon0", "the processor first");
        Harness.equal(seen[1], "thermal:thermal_zone1", "then its distinct thermal zone");
        Harness.equal(seen[2], "hwmon:hwmon3", "then the graphics card");
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

cases["a thermal zone is not deduplicated by its display name"] = function () {
    on("machine", function () {
        let found = Sensors.discoverSensors();
        Harness.ok(byId(found.temperatures, "thermal:thermal_zone0"),
                   "acpitz is not a hwmon chip here, so it is kept");
        Harness.ok(byId(found.temperatures, "thermal:thermal_zone1"),
                   "a same-named k10temp zone with no shared device identity is distinct");
    });
};

cases["class links compare as canonical device identities"] = function () {
    let realLink = IO.readLink;
    let realResolve = IO.resolve;
    IO.readLink = () => "../../../devices/platform/coretemp.0";
    IO.resolve = path => "/capture" + path;
    try {
        Harness.equal(Sensors.deviceIdentity("/sys/class/hwmon/hwmon0"),
                      "/capture/sys/devices/platform/coretemp.0",
                      "relative class links name their backing device");
    } finally {
        IO.readLink = realLink;
        IO.resolve = realResolve;
    }
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

cases["only an unambiguous GPU total is aggregatable"] = function () {
    let lone = { rawLabel: null };
    Harness.equal(Sensors.gpuDeviceTotal([lone]), lone,
                  "the common lone unlabelled device meter");

    let total = { rawLabel: "PPT" };
    let core = { rawLabel: "VDDGFX" };
    let memory = { rawLabel: "Memory rail" };
    Harness.equal(Sensors.gpuDeviceTotal([total, core, memory]), total,
                  "an explicit whole-device channel is selected among rails");
    Harness.equal(Sensors.gpuDeviceTotal([core, memory]), null,
                  "rails with no declared total remain individual readings");
    Harness.equal(Sensors.gpuDeviceTotal([{ rawLabel: "Total" },
                                          { rawLabel: "Board power" }]), null,
                  "two competing totals are ambiguous rather than additive");
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

cases["an unlabelled fan stays known after it has run"] = function () {
    on("machine", function () {
        let set = new Sensors.SensorSet();
        let sensor = set.fanSensors[0];
        sensor.rawLabel = null;

        Harness.equal(set._fan(sensor, () => 1200).inUse, true, "known while turning");
        let stopped = set._fan(sensor, () => 0);
        Harness.equal(stopped.inUse, true, "still known after stopping");
        Harness.equal(stopped.rpm, 0, "zero is preserved as the reading");
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

cases["a RAPL domain is named after what it measures"] = function () {
    on("machine", function () {
        let counters = Sensors.discoverEnergyCounters();
        Harness.equal(byId(counters, "rapl:intel-rapl:0").label, "Package 0",
                      "two sockets, so each says which it is");
        Harness.equal(byId(counters, "rapl:intel-rapl:1").label, "Package 1", "the other");
        Harness.equal(byId(counters, "rapl:intel-rapl:0:0").label, "Cores",
                      "the cores inside the first");
        Harness.equal(byId(counters, "rapl:dtpm:0").label, "dtpm:0",
                      "a name nothing knows is left as it was found");
    });
};

cases["one socket has no number to say"] = function () {
    on("one-socket", function () {
        let counters = Sensors.discoverEnergyCounters();
        Harness.equal(byId(counters, "rapl:intel-rapl:0").label, "Package",
                      "nothing to tell it apart from");
        Harness.equal(byId(counters, "rapl:intel-rapl:0:0").label, "Cores", "and its cores");
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

cases["sensors sort by kind, then by measure, then by name"] = function () {
    let list = [{ kind: "disk", label: "b" }, { kind: "cpu", label: "z" },
                { kind: "cpu", label: "a" }, { kind: "nonsense", label: "a" }];
    list.sort(Sensors.bySensorOrder);
    Harness.deepEqual(list.map(e => e.kind + ":" + e.label),
                      ["cpu:a", "cpu:z", "disk:b", "nonsense:a"],
                      "with no measure to compare, kind then name");

    /* A card's fan belongs under its temperature, not several rows below it
     * with another chip's readings in between. */
    let card = [{ kind: "gpu", measure: "power", label: "amdgpu PPT" },
                { kind: "gpu", measure: "fan", label: "amdgpu" },
                { kind: "cpu", measure: "temperature", label: "k10temp Tctl" },
                { kind: "gpu", measure: "temperature", label: "amdgpu edge" }];
    card.sort(Sensors.bySensorOrder);
    Harness.deepEqual(card.map(e => e.measure + ":" + e.label),
                      ["temperature:k10temp Tctl", "temperature:amdgpu edge",
                       "fan:amdgpu", "power:amdgpu PPT"],
                      "the processor first, then everything the card says");
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
        Harness.deepEqual(control.batteries,
                          [{ name: "BAT0",
                             path: "/sys/class/power_supply/BAT0/charge_control_end_threshold" }],
                          "the mains entry is not a battery");
    });
};

cases["every battery with a threshold is found, not the first"] = function () {
    on("two-batteries", function () {
        let control = PowerSupply.discoverChargeControl();
        Harness.deepEqual(control.batteries.map(battery => battery.name), ["BAT0", "BAT1"],
                          "the helper writes both, so both have to be read");
        Harness.deepEqual(control.limits, [80, 100], "each one's own");
    });
};

cases["two batteries set apart read as no one limit, and say so"] = function () {
    on("two-batteries", function () {
        let reading = PowerSupply.discoverChargeControl().reading();
        Harness.equal(reading.limit, null,
                      "one of the two would be a number the other battery is not at");
        Harness.equal(reading.state, "divided", "the explicit multi-battery state");
        Harness.equal(reading.divided, true, "and that is worth saying out loud");
    });
};

cases["one battery reads as its own limit"] = function () {
    on("machine", function () {
        let reading = PowerSupply.discoverChargeControl().reading();
        Harness.equal(reading.limit, 80, "what the one battery says");
        Harness.equal(reading.state, "agreed", "a complete agreed read");
        Harness.equal(reading.divided, false, "with nothing to disagree with");
    });
};

cases["a battery that will not answer is not two batteries disagreeing"] = function () {
    on("two-batteries", function () {
        let control = PowerSupply.discoverChargeControl();
        IO.setRoot("/nonexistent");
        let reading = control.reading();
        Harness.equal(reading.limit, null, "nothing to show");
        Harness.equal(reading.state, "incomplete", "the failed reads are explicit");
        Harness.equal(reading.divided, false,
                      "a control with nothing behind it speaks for itself");
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

cases["a reading only touches the sensors it was asked for"] = function () {
    on("machine", function () {
        let set = new Sensors.SensorSet();
        let all = set.read();
        let primary = set.read(sensor => Sensors.isPrimaryKind(sensor.kind));
        Harness.equal(all.temperatures.length, 8, "everything");
        Harness.equal(primary.temperatures.length, 5, "the cpu and gpu ones only");
        Harness.equal(primary.temperatures.every(t => t.kind === "cpu" || t.kind === "gpu"), true,
                      "and nothing else got read");
        Harness.equal(primary.fans.length, 1, "the card's fan is a gpu sensor");
    });
};

cases["a filter that says no to everything reads nothing"] = function () {
    on("machine", function () {
        let readings = new Sensors.SensorSet().read(() => false);
        Harness.equal(readings.temperatures.length, 0, "temperatures");
        Harness.equal(readings.fans.length, 0, "fans");
        Harness.equal(readings.powers.length, 0, "powers");
        Harness.equal(readings.packageWatts, null, "and no package total");
    });
};

/* ---------------------------------------------------------------- */
/* reading without blocking                                          */

cases["asynchronous discovery produces the synchronous snapshot"] = function () {
    on("machine", function () {
        let expected = Sensors.discoverSensors();
        Hardware.forget();
        let actual = Harness.settle(done => Sensors.discoverSensorsAsync(done),
                                    "discoverSensorsAsync");
        Harness.deepEqual(actual, expected,
                          "directory and metadata reads do not change discovery semantics");
    });
};

cases["an asynchronous sensor set keeps an atomic snapshot"] = function () {
    on("machine", function () {
        let set;
        let before;
        Harness.settle(function (done) {
            set = new Sensors.SensorSet({
                asynchronous: true,
                onChanged: () => done(true),
            });
            before = set.temperatureSensors.length;
        }, "initial sensor discovery");
        Harness.equal(before, 0, "construction does not block to populate a partial snapshot");
        Harness.equal(set.temperatureSensors.length, 8, "the complete snapshot is adopted together");
        Harness.equal(set.fanSensors.length, 1, "including fans");
        Harness.equal(set.powerSensors.length, 3, "and power meters");
        Harness.equal(set.refresh(), false, "the asynchronous topology signature is current");
    });
};

cases["an asynchronous directory listing matches the synchronous one"] = function () {
    on("machine", function () {
        let expected = IO.listDir("/sys/class/hwmon");
        let actual = Harness.settle(
            done => IO.listDirAsync("/sys/class/hwmon", done), "listDirAsync");
        Harness.deepEqual(actual, expected, "same naturally sorted entries");
    });
};

/*
 * A fresh set per reading, because the energy meters remember their last
 * counter value: the same set read twice would compute watts the second time
 * and not the first, and the two answers would differ for a reason that has
 * nothing to do with how they were read.
 */
cases["an asynchronous reading says exactly what a synchronous one says"] = function () {
    on("machine", function () {
        let expected = new Sensors.SensorSet().read();
        let set = new Sensors.SensorSet();
        let actual = Harness.settle(done => set.readAsync(null, done), "readAsync");
        Harness.deepEqual(actual, expected,
                          "the two share one assembly, so only the bytes' route differs");
    });
};

cases["an asynchronous reading reads only what it was asked for"] = function () {
    on("machine", function () {
        let set = new Sensors.SensorSet();
        let readings = Harness.settle(
            done => set.readAsync(sensor => Sensors.isPrimaryKind(sensor.kind), done),
            "readAsync");
        Harness.equal(readings.temperatures.length, 5, "the cpu and gpu ones only");
        Harness.equal(readings.temperatures.every(t => t.kind === "cpu" || t.kind === "gpu"), true,
                      "and nothing else");
        Harness.equal(readings.fans.length, 1, "the card's fan");
    });
};

cases["an asynchronous reading with nothing to read still answers"] = function () {
    on("machine", function () {
        let set = new Sensors.SensorSet();
        let readings = Harness.settle(done => set.readAsync(() => false, done), "readAsync");
        Harness.equal(readings.temperatures.length, 0, "temperatures");
        Harness.equal(readings.fans.length, 0, "fans");
        Harness.equal(readings.powers.length, 0, "powers");
        Harness.equal(readings.packageWatts, null, "and no package total");
    });
};

cases["a machine whose nodes cannot be read answers with nulls"] = function () {
    IO.setRoot(Harness.fixture("machine"));
    let set = new Sensors.SensorSet();
    IO.setRoot("/nonexistent");
    try {
        let readings = Harness.settle(done => set.readAsync(null, done), "readAsync");
        Harness.equal(readings.temperatures.length, 8, "the sensors are still known");
        Harness.equal(readings.temperatures.every(t => t.celsius === null), true,
                      "with nothing to say, rather than never answering at all");
        Harness.equal(readings.fans.every(f => f.rpm === null), true, "and the same for fans");
    } finally {
        IO.setRoot("");
    }
};

cases["a batch of paths comes back keyed by path"] = function () {
    on("machine", function () {
        let values = Harness.settle(
            done => IO.readStringsAsync(["/sys/class/hwmon/hwmon0/name",
                                         "/sys/class/hwmon/nothing-here"], done),
            "readStringsAsync");
        Harness.equal(values["/sys/class/hwmon/hwmon0/name"], "k10temp", "what the driver calls it");
        Harness.equal(values["/sys/class/hwmon/nothing-here"], null,
                      "a node that is not there is null, not an error");
    });
};

/* ---------------------------------------------------------------- */
/* the platform profile as a backend                                 */

cases["the platform profile answers the same questions the daemon does"] = function () {
    on("machine", function () {
        let client = new PowerSupply.PlatformProfileClient();
        Harness.equal(client.available, true, "available");
        Harness.equal(client.active, "balanced", "active");
        Harness.deepEqual(client.profiles, ["quiet", "balanced", "performance"], "profiles");
        Harness.equal(client.busName, "acpi-platform-profile", "which backend this is");
        Harness.equal(client.degraded, "", "firmware says nothing about degradation");
        Harness.deepEqual(client.holds, [], "or about applications holding a profile");
    });
};

cases["a machine with no platform profile says it is unavailable"] = function () {
    IO.setRoot("/nonexistent");
    try {
        let client = new PowerSupply.PlatformProfileClient();
        Harness.equal(client.available, false, "available");
        Harness.equal(client.active, null, "active");
        Harness.deepEqual(client.profiles, [], "profiles");
    } finally {
        IO.setRoot("");
    }
};

cases["the platform profile is written through the helper"] = function () {
    on("machine", function () {
        let sent = [];
        let client = new PowerSupply.PlatformProfileClient(function (args, done) {
            sent.push(args.join(" "));
            done({ applied: true });
        });
        let error = "not called";
        client.setProfile("quiet", e => { error = e; });
        Harness.deepEqual(sent, ["platform-profile quiet"], "the helper's own vocabulary");
        Harness.equal(error, null, "and it reported success");
    });
};

cases["a refused platform profile reports the refusal"] = function () {
    on("machine", function () {
        let client = new PowerSupply.PlatformProfileClient(
            (args, done) => done({ applied: false, error: "unknown platform profile: nonsense" }));
        let error = null;
        client.setProfile("nonsense", e => { error = e; });
        Harness.ok(error, "an error");
        Harness.equal(error.message, "unknown platform profile: nonsense", "with the reason");
    });
};

cases["the platform profile answers a whole reading from one look"] = function () {
    on("machine", function () {
        let client = new PowerSupply.PlatformProfileClient();
        let state = client.snapshot();
        Harness.equal(state.available, true, "available");
        Harness.equal(state.busName, "acpi-platform-profile", "which backend");
        Harness.equal(state.active, "balanced", "active");
        Harness.deepEqual(state.profiles, ["quiet", "balanced", "performance"], "profiles");
        Harness.equal(state.degraded, "", "the firmware says nothing about degradation");
        Harness.deepEqual(state.holds, [], "or about applications holding a profile");

        /* The same six answers the getters give, so a caller can use either. */
        Harness.deepEqual(
            state,
            { available: client.available, busName: client.busName, active: client.active,
              profiles: client.profiles, degraded: client.degraded, holds: client.holds },
            "one look and six looks agree");
    });
};

cases["a machine with no platform profile snapshots as unavailable"] = function () {
    IO.setRoot("/nonexistent");
    try {
        let state = new PowerSupply.PlatformProfileClient().snapshot();
        Harness.equal(state.available, false, "unavailable");
        Harness.equal(state.active, null, "no active profile");
        Harness.deepEqual(state.profiles, [], "and none to choose from");
    } finally {
        IO.setRoot("");
    }
};

cases["a rediscovery during a reading does not empty it"] = function () {
    /*
     * The paths are collected before the read and the reading used to be
     * assembled out of whatever the lists held afterwards, so a sweep in
     * between meant looking up the new machine's sensors in an answer keyed by
     * the old machine's: every value missing, and one poll where everything
     * read null.
     *
     * Both callers refresh before they update, so it takes an update deferred
     * by an in-flight read to finish after the next tick's sweep. The sweep
     * here finds a machine with no hwmon at all, which is the whole of what
     * makes this different from rediscovering the same fixture twice.
     */
    on("machine", function () {
        let set = new Sensors.SensorSet();
        let before = set.temperatureSensors.length;
        Harness.ok(before > 0, "the fixture has sensors to lose");

        let answer = Harness.settle(function (done) {
            set.readAsync(null, done);
            IO.setRoot(Harness.fixture("inverted-boost"));
            set.discover();
        }, "the reading");

        Harness.equal(set.temperatureSensors.length, 0, "the sweep did land, and found nothing");
        Harness.equal(answer.temperatures.length, before,
                      "and the reading is still of the machine it was taken from");
        Harness.ok(answer.temperatures.every(entry => entry.celsius !== null),
                   "with every value in it, rather than a null where the lookup missed");
    });
};

cases["a reading taken after a rediscovery is the new machine's"] = function () {
    /* The other half: holding the lists for one read must not mean holding
     * them for the next. */
    on("inverted-boost", function () {
        let set = new Sensors.SensorSet();
        Harness.equal(set.temperatureSensors.length, 0, "nothing here to read");

        IO.setRoot(Harness.fixture("machine"));
        set.discover();
        let answer = Harness.settle(done => set.readAsync(null, done), "the reading");
        Harness.equal(answer.temperatures.length, set.temperatureSensors.length,
                      "as many as the sweep that just ran found");
        Harness.ok(answer.temperatures.length > 0, "which is some");
    });
};

cases["a sweep is only run again where the hardware has moved"] = function () {
    /*
     * The menu asks for this every time it opens. A full sweep reads every
     * label, name and type file under three directory trees, so doing it on
     * every open would be a hundred reads to answer a question whose answer is
     * almost always "the same machine as last time".
     *
     * What it costs instead is three directory listings, and what those catch
     * is a card waking up, a sensor being unplugged or a driver being loaded -
     * anything that adds or removes a node. A change inside a directory that
     * was already there is missed until the next real one, which is the trade
     * this is written to make.
     */
    on("machine", function () {
        let set = new Sensors.SensorSet();
        Harness.ok(set.temperatureSensors.length > 0, "a machine with sensors on it");

        Harness.equal(set.refresh(), false, "nothing has moved, so nothing is swept");
        Harness.ok(set.temperatureSensors.length > 0, "and the lists are still the ones it had");

        /* Every one of the three trees gone at once, which is what a fixture
         * with none of them stands in for. */
        IO.setRoot(Harness.fixture("inverted-boost"));
        Harness.equal(set.refresh(), true, "the hardware moved, so it swept again");
        Harness.equal(set.temperatureSensors.length, 0, "and found what is there now");
        Harness.equal(set.energyMeters.length, 0, "meters and all");

        Harness.equal(set.refresh(), false, "and the new shape is the one it now knows");
    });
};

cases["a sensor node changing inside an existing device triggers a sweep"] = function () {
    on("machine", function () {
        let originalListDir = IO.listDir;
        let extraNode = false;
        IO.listDir = function (path) {
            let entries = originalListDir(path);
            if (extraNode && /\/hwmon0$/.test(path))
                return entries.concat(["temp99_input"]).sort(IO.naturalCompare);
            return entries;
        };
        try {
            let set = new Sensors.SensorSet();
            let before = set.temperatureSensors.length;
            Harness.equal(set.refresh(), false, "the unchanged nested inventory is current");

            extraNode = true;
            Harness.equal(set.refresh(), true, "the new channel changes topology");
            Harness.equal(set.temperatureSensors.length, before + 1,
                          "rediscovery adopts the channel without a new hwmon device");
            Harness.equal(set.refresh(), false, "the expanded inventory is remembered");
        } finally {
            IO.listDir = originalListDir;
        }
    });
};

cases["RAPL access changing is a topology change"] = function () {
    on("machine", function () {
        let originalCanRead = IO.canRead;
        let originalReadString = IO.readString;
        let readable = true;
        let isEnergy = path => /\/powercap\/[^/]+\/energy_uj$/.test(path);
        IO.canRead = path => isEnergy(path) ? readable : originalCanRead(path);
        IO.readString = path => isEnergy(path) && !readable
            ? null : originalReadString(path);
        try {
            let set = new Sensors.SensorSet();
            Harness.ok(set.energyMeters.length > 0, "the readable counters are discovered");

            readable = false;
            Harness.equal(set.refresh(), true, "permission alone triggers a new sweep");
            Harness.equal(set.energyMeters.length, 0, "restricted counters leave the snapshot");
            Harness.equal(set.refresh(), false, "the new permission state is remembered");
        } finally {
            IO.canRead = originalCanRead;
            IO.readString = originalReadString;
        }
    });
};
