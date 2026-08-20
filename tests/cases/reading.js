/*
 * What one reading of the machine comes to.
 *
 * These were free functions at the top of applet.js, which no case can load,
 * so nothing here had ever been checked - including profileOwnsGovernor, which
 * decides whether the governor is a control or a readout and is the single
 * largest thing the menu does differently from one machine to the next.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;
const UPowerGlib = imports.gi.UPowerGlib;

const SensorKinds = Harness.requireXlet("./lib/sensor-kinds.js");
const Backends = Harness.requireXlet("./lib/backends.js");
const Reading = Harness.requireXlet("./lib/reading.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");

/* The matcher is the caller's to supply; the applet supplies this one. */
function pickTemperature(temperatures, hint) {
    return Reading.pickTemperature(temperatures, hint, SensorKinds.sensorMatches);
}

const State = UPowerGlib.DeviceState;

/* A temperature reading, the shape lib/sensors.js produces. */
function temperature(chip, rawLabel, kind, celsius) {
    return { id: chip + ":" + rawLabel, measure: "temperature", chip: chip,
             rawLabel: rawLabel, kind: kind, celsius: celsius };
}

/* The profile block of a reading, as _collectProfile assembles it. */
function profile(overrides) {
    return { profile: Object.assign({
        available: true,
        backend: "net.hadess.PowerProfiles",
        active: "balanced",
        list: ["power-saver", "balanced", "performance"],
        degraded: "",
        holds: [],
    }, overrides || {}) };
}

function power(watts, source) {
    return { systemWatts: watts, systemWattsSource: source };
}

var cases = {};

cases["a power figure says which power it is"] = function () {
    /* Different measurements of different things, and a bare
     * number would read as the machine's draw whichever it was. */
    Harness.equal(Reading.powerText(power(8.4, "battery")), "8.4 W (battery)", "battery");
    Harness.equal(Reading.powerText(power(72, "platform")), "72 W (platform total)", "DTPM");
    Harness.equal(Reading.powerText(power(54, "package")), "54 W (package)", "the socket");
    Harness.equal(Reading.powerText(power(54, "gpu")), "54 W (GPU)", "a graphics card");
};

cases["a power figure nothing measured is not a figure"] = function () {
    Harness.equal(Reading.powerText(power(null, null)), "", "nothing to say");
    Harness.equal(Reading.powerText(power(12, "something-new")), "12 W",
                  "an unknown source is left unnamed rather than guessed at");
};

cases["the panel spells out only the sources that need it"] = function () {
    /* What a battery is losing is the whole machine and needs no explanation;
     * the other two are one part of it and a bare number there misleads. */
    Harness.equal(Reading.panelPowerText(power(8.4, "battery")), "8.4 W", "no room, no need");
    Harness.equal(Reading.panelPowerText(power(72, "platform")), "72 W (platform total)",
                  "the DTPM aggregate names its source");
    Harness.equal(Reading.panelPowerText(power(54, "package")), "54 W (package)",
                  "worth the characters, because it is not the machine");
    Harness.equal(Reading.panelPowerText(power(54, "gpu")), "54 W (GPU)", "likewise");
};

cases["the profile drawn is the one asked for while it is in flight"] = function () {
    let data = profile({ active: "balanced" });
    Harness.equal(Reading.shownProfile(data, {}), "balanced", "what the machine says");
    Harness.equal(Reading.shownProfile(data, { pendingProfile: "performance" }), "performance",
                  "what was asked for, until the machine catches up");
    Harness.equal(Reading.shownProfile(data, null), "balanced", "with no options at all");
    Harness.equal(Reading.shownProfile(profile({ active: null }), {}), null,
                  "a machine with no profile has none to draw");
};

cases["power-profiles-daemon owns the governor"] = function () {
    /* It writes both from whichever profile is in force and writes them again
     * on the next change, so a governor chosen by hand holds until then and no
     * longer. The menu says it once, as the profile. */
    Harness.equal(Reading.profileOwnsGovernor(profile()), true, "the daemon");
    Harness.equal(
        Reading.profileOwnsGovernor(profile({ backend: "org.freedesktop.UPower.PowerProfiles" })),
        true, "under either of its names");
};

cases["the firmware profile does not own the governor"] = function () {
    /* It writes firmware and never goes near cpufreq, so there the governor is
     * the only way to ask for speed and stays a control. */
    Harness.equal(
        Reading.profileOwnsGovernor(profile({ backend: Backends.PLATFORM_BACKEND })),
        false, "ACPI writes firmware, not cpufreq");
};

cases["a machine with no profiles does not own the governor either"] = function () {
    Harness.equal(Reading.profileOwnsGovernor(profile({ available: false })), false,
                  "nothing is writing it");
    Harness.equal(Reading.profileOwnsGovernor(profile({ backend: null })), false,
                  "and nothing claims to be");
};

cases["only firmware profiles follow the privileged setting"] = function () {
    Harness.equal(Reading.profileCanChange(profile(), false), true,
                  "the session daemon remains writable");
    let firmware = profile({ backend: Backends.PLATFORM_BACKEND });
    Harness.equal(Reading.profileCanChange(firmware, true), true,
                  "ACPI is writable when privileged controls are allowed");
    Harness.equal(Reading.profileCanChange(firmware, false), false,
                  "and read-only when they are disabled");
    Harness.equal(Reading.profileCanChange(profile({ available: false }), true), false,
                  "an unavailable backend is not writable");
};

cases["a privileged change is described in the helper's own vocabulary"] = function () {
    /* The argument vectors are what the helper takes; this is the one place
     * that turns them back into something worth reading. */
    Harness.equal(Reading.describeChange(["governor", "powersave"]), "Governor: Power save", "governor");
    Harness.equal(Reading.describeChange(["epp", "balance_power"]),
                  "Energy preference: Balance power", "energy preference");
    Harness.equal(Reading.describeChange(["boost", "1"]), "Turbo boost on", "boost on");
    Harness.equal(Reading.describeChange(["boost", "0"]), "Turbo boost off", "boost off");
    Harness.equal(Reading.describeChange(["boost", 1]), "Turbo boost on",
                  "whether the helper was handed a string or a number");
    Harness.equal(Reading.describeChange(["charge-threshold", "80"]), "Charge limit: 80%", "limit");
};

cases["a change nobody has words for is silent, not wrong"] = function () {
    Harness.equal(Reading.describeChange(["something-new", "x"]), "",
                  "the caller shows nothing rather than a half-formed sentence");
};

cases["the platform profile is not described here"] = function () {
    /*
     * The helper takes five commands and this describes four. The fifth is
     * only ever sent through _runHelperQuietly, which reports in its own words
     * because a profile that will not switch has a panel gauge and a filled
     * segment to take back with it. A branch for it here read as a caller that
     * has never existed, and it stays gone as long as this case does.
     */
    Harness.equal(Reading.describeChange(["platform-profile", "performance"]), "",
                  "said by whoever asked for it, not by the general describer");
};

/* ---------------------------------------------------------------- */
/* which reading stands for the machine                              */

const K10 = temperature("k10temp", "Tctl", "cpu", 62.5);
const TDIE = temperature("k10temp", "Tdie", "cpu", 60.0);
const CCD = temperature("k10temp", "Tccd1", "cpu", 58.0);
const AMDGPU = temperature("amdgpu", "edge", "gpu", 41.0);
const NVME = temperature("nvme", null, "disk", 38.0);

cases["the processor's own reading is what stands for the machine"] = function () {
    let picked = pickTemperature([NVME, AMDGPU, CCD, K10], "");
    Harness.equal(picked.sensor.rawLabel, "Tctl",
                  "the one AMD publishes as the package's control value");
    Harness.equal(picked.hintMatched, null, "nobody asked for a particular one");
};

cases["the preference order is followed, not the discovery order"] = function () {
    /* Tccd1 comes off the same chip and is discovered first here; it is one
     * chiplet, not the package. */
    Harness.equal(pickTemperature([CCD, TDIE], "").sensor.rawLabel, "Tdie", "Tdie over Tccd1");
    Harness.equal(pickTemperature([CCD, TDIE, K10], "").sensor.rawLabel, "Tctl",
                  "and Tctl over Tdie");
};

cases["a processor with nothing recognisable still answers"] = function () {
    let odd = temperature("soc_thermal", null, "cpu", 55.0);
    Harness.equal(pickTemperature([AMDGPU, odd], "").sensor.chip, "soc_thermal",
                  "any CPU sensor beats a GPU one");
};

cases["a machine with no processor sensor falls back to the graphics card"] = function () {
    Harness.equal(pickTemperature([NVME, AMDGPU], "").sensor.chip, "amdgpu", "the GPU");
    Harness.equal(pickTemperature([NVME], "").sensor.chip, "nvme",
                  "and then to whatever there is, rather than to nothing");
};

cases["a machine that reports nothing readable says so"] = function () {
    let dead = temperature("amdgpu", "edge", "gpu", null);
    let picked = pickTemperature([dead], "");
    Harness.equal(picked.sensor, null, "no sensor");
    Harness.equal(picked.hintMatched, null, "and no hint to have failed");
};

cases["a hint chooses the sensor, whatever kind it is"] = function () {
    /* Matched on what the driver calls it, so a disk can be named on purpose
     * and the sensor filter keeps it for that reason. */
    let picked = pickTemperature([K10, AMDGPU, NVME], "nvme");
    Harness.equal(picked.sensor.chip, "nvme", "the one that was asked for");
    Harness.equal(picked.hintMatched, true, "and it was found");
};

cases["a hint is matched on the driver's word, not the menu's"] = function () {
    Harness.equal(pickTemperature([K10, AMDGPU], "Tctl").sensor.rawLabel, "Tctl",
                  "the label");
    Harness.equal(pickTemperature([K10, AMDGPU], "amdgpu").sensor.chip, "amdgpu",
                  "or the chip");
};

cases["a hint that matches nothing is reported, not swallowed"] = function () {
    /* Somebody who typed a name has no other way of finding out it was
     * ignored, so the menu says so - which it can only do because of this. */
    let picked = pickTemperature([K10, AMDGPU], "coretemp");
    Harness.equal(picked.sensor.rawLabel, "Tctl", "the automatic choice still happens");
    Harness.equal(picked.hintMatched, false, "but the hint did not, and that is worth saying");
};

cases["a battery on the way down is the machine's power draw"] = function () {
    let battery = { state: State.DISCHARGING, energyRate: 11.2 };
    Harness.deepEqual(Reading.pickPower(battery, 54, [{ kind: "gpu", watts: 30 }]),
                      { watts: 11.2, source: "battery" },
                      "what the whole machine is losing beats a part of it");
};

cases["a battery on the cable is not a draw"] = function () {
    let charging = { state: State.CHARGING, energyRate: 45 };
    Harness.deepEqual(Reading.pickPower(charging, 54, []), { watts: 54, source: "package" },
                      "45 W into the battery is not 45 W out of the machine");
};

cases["a DTPM platform total comes before component totals"] = function () {
    let powers = [
        { id: "dtpm-root", platformTotal: true, watts: 72 },
        { id: "dtpm-child", platformTotal: false, watts: 20 },
        { id: "gpu", kind: "gpu", deviceTotal: true, watts: 30 },
    ];
    Harness.deepEqual(Reading.pickPower(null, 54, powers),
                      { watts: 72, source: "platform" },
                      "the root wins without adding its children or RAPL");
};

cases["the package counter comes before the graphics card"] = function () {
    Harness.deepEqual(Reading.pickPower(null, 54, [{ kind: "gpu", watts: 30 }]),
                      { watts: 54, source: "package" }, "RAPL where it can be read");
};

cases["graphics cards are added together when there is nothing else"] = function () {
    let powers = [{ id: "gpu0", group: "gpu0", kind: "gpu", deviceTotal: true, watts: 30 },
                  { id: "gpu1", group: "gpu1", kind: "gpu", deviceTotal: true, watts: 24 },
                  { kind: "cpu", watts: 19 }];
    Harness.deepEqual(Reading.pickPower(null, null, powers), { watts: 54, source: "gpu" },
                      "both cards, and nothing that is not one");
};

cases["GPU rails are not added to their device total"] = function () {
    let powers = [
        { id: "total", group: "gpu0", kind: "gpu", deviceTotal: true, watts: 80 },
        { id: "core", group: "gpu0", kind: "gpu", deviceTotal: false, watts: 45 },
        { id: "memory", group: "gpu0", kind: "gpu", deviceTotal: false, watts: 20 },
    ];
    Harness.deepEqual(Reading.pickPower(null, null, powers), { watts: 80, source: "gpu" },
                      "one whole-device figure, without the rails inside it");

    for (let meter of powers)
        meter.deviceTotal = false;
    Harness.deepEqual(Reading.pickPower(null, null, powers), { watts: null, source: null },
                      "ambiguous channels produce no fabricated panel total");
};

cases["a machine that measures no power says so rather than showing a zero"] = function () {
    Harness.deepEqual(Reading.pickPower(null, null, []), { watts: null, source: null },
                      "nothing measured is not nought watts");
    for (let watts of [null, undefined, NaN, Infinity, -Infinity]) {
        Harness.deepEqual(Reading.pickPower(null, null, [
            { id: "gpu0", group: "gpu0", kind: "gpu", deviceTotal: true, watts: watts },
        ]), { watts: null, source: null },
        "an unreadable GPU total is absent, not coerced to zero: " + String(watts));
    }
};

/* ---------------------------------------------------------------- */
/* the questions asked of a reading, over readings nobody wrote      */

cases["which sensor the machine is judged by is always one that answered"] = function () {
    /*
     * This one number is the panel tooltip's temperature and the value the
     * high temperature alert fires against, so picking a sensor that has no
     * reading means an alert that can never fire and a tooltip line that is
     * blank on a machine full of working sensors.
     *
     * Whatever the list, what comes back has to be a sensor from it that has a
     * temperature, or nothing at all - and hintMatched has to agree with what
     * was asked for.
     */
    let kinds = ["cpu", "gpu", "board", "disk", "battery", "other"];
    let labels = ["Tctl", "Tdie", "Package id 0", "edge", "junction", "Composite", ""];

    Fuzz.forAll({ what: "pickTemperature", runs: 500 }, random => {
        let sensors = [];
        let count = random.below(6);
        for (let i = 0; i < count; i++) {
            sensors.push({
                id: "sensor:" + i,
                kind: random.pick(kinds),
                chip: random.pick(["k10temp", "amdgpu", "nvme", "acpitz", ""]),
                rawLabel: random.pick(labels),
                celsius: random.chance(3) ? null : random.between(-40, 120),
            });
        }
        return { sensors: sensors, hint: random.chance(3) ? Fuzz.text(random, 2) : "" };
    }, input => {
        let picked = Fuzz.answers(() => pickTemperature(input.sensors, input.hint));

        if (picked.sensor !== null) {
            if (input.sensors.indexOf(picked.sensor) < 0)
                throw new Error("picked a sensor that is not in the list");
            if (picked.sensor.celsius === null)
                throw new Error("picked a sensor with no reading");
        } else if (input.sensors.some(sensor => sensor.celsius !== null)) {
            throw new Error("picked nothing while something was readable");
        }

        let asked = (input.hint || "").trim() !== "";
        if (!asked && picked.hintMatched !== null)
            throw new Error("nothing was asked for, and hintMatched is " + picked.hintMatched);
        if (asked && picked.sensor === null && picked.hintMatched !== null)
            throw new Error("nothing readable at all, and hintMatched is " + picked.hintMatched);
        if (picked.hintMatched === true && picked.sensor === null)
            throw new Error("matched a hint against nothing");
    });
};

cases["a hint that matches nothing is said so rather than ignored"] = function () {
    /* There is no other way to find out a typed name was not recognised: the
     * applet quietly falls back to the processor and the row somebody was
     * looking for never appears. */
    let sensors = [{ id: "a", kind: "cpu", chip: "k10temp", rawLabel: "Tctl", celsius: 50 }];
    Harness.equal(pickTemperature(sensors, "k10temp").hintMatched, true, "chip matched");
    Harness.equal(pickTemperature(sensors, "Tctl").hintMatched, true, "label matched");
    Harness.equal(pickTemperature(sensors, "nvme").hintMatched, false,
                  "asked for, and not there");
    Harness.equal(pickTemperature(sensors, "  ").hintMatched, null, "asked for nothing");
    Harness.equal(pickTemperature([], "k10temp").hintMatched, null,
                  "nothing readable, so the hint was never the reason");
};

cases["the power figure always says which power it is"] = function () {
    /*
     * These measure very different things - a whole machine on battery, a
     * processor package, a graphics card - so a number without its source is
     * misleading rather than incomplete: a desktop that cannot read its RAPL
     * counters would show the card's 54 W as if it were the lot.
     */
    Fuzz.forAll({ what: "pickPower", runs: 400 }, random => ({
        primary: random.chance(3) ? null : {
            state: random.pick([UPowerGlib.DeviceState.DISCHARGING,
                                UPowerGlib.DeviceState.CHARGING,
                                UPowerGlib.DeviceState.FULLY_CHARGED]),
            energyRate: random.chance(3) ? null : random.between(0, 90),
        },
        packageWatts: random.chance(2) ? null : random.between(0, 200),
        powers: [0, 1, 2].slice(0, random.below(3)).map(i => ({
            id: "power:" + i,
            group: "device:" + i,
            kind: random.pick(["gpu", "package", "battery"]),
            deviceTotal: random.chance(2),
            watts: random.chance(4) ? random.between(0, 200)
                                    : random.pick([null, undefined, NaN, Infinity, -Infinity]),
        })),
    }), input => {
        let power = Fuzz.answers(() =>
            Reading.pickPower(input.primary, input.packageWatts, input.powers));

        if (power.watts === null) {
            if (power.source !== null)
                throw new Error("no figure, but a source of " + power.source);
            return;
        }
        if (typeof power.watts !== "number" || !Number.isFinite(power.watts))
            throw new Error("a figure of " + String(power.watts));
        if (["battery", "package", "gpu"].indexOf(power.source) < 0)
            throw new Error("a figure from " + String(power.source));

        /* And the text that goes with it names that source, since the two are
         * shown together and never apart. */
        let text = Reading.powerText({ systemWatts: power.watts, systemWattsSource: power.source });
        Fuzz.isText(text, "the power text");
        if (text.indexOf("W") < 0)
            throw new Error("no unit in " + JSON.stringify(text));
    });
};

cases["the panel says which power it is, except where it cannot be anything else"] = function () {
    /* Every character costs on a panel. What a battery is losing is the whole
     * machine and needs no explanation; the other two are one part of it, and
     * a bare number there reads as system power when it is not. */
    Harness.equal(Reading.panelPowerText({ systemWatts: 12, systemWattsSource: "battery" }),
                  "12 W", "on battery, the number alone");
    Harness.equal(Reading.panelPowerText({ systemWatts: 54, systemWattsSource: "gpu" }),
                  "54 W (GPU)", "a graphics card says so");
    Harness.equal(Reading.panelPowerText({ systemWatts: 54, systemWattsSource: "package" }),
                  "54 W (package)", "and so does a processor package");
    Harness.equal(Reading.panelPowerText({ systemWatts: null, systemWattsSource: null }), "",
                  "and nothing is nothing");
};

cases["a source with no name of its own is named as nothing"] = function () {
    /* The label is concatenated into a line, so a source this does not know
     * has to answer with a string. Anything else reaches the panel as itself. */
    Harness.equal(Reading.powerSourceLabel("battery"), "battery", "one it knows");
    Harness.equal(Reading.powerSourceLabel("something-new"), "",
                  "and one it does not, as text rather than as nothing");
    Harness.equal(Reading.powerSourceLabel(null), "", "or as no source at all");
};

cases["one graphics card on its own is still the machine's power figure"] = function () {
    /*
     * The last resort, and the common one on a desktop: no battery to measure
     * and RAPL counters this user cannot read, so what is left is whatever the
     * cards report. One card is a machine, not a special case.
     */
    let one = Reading.pickPower(null, null,
                                [{ id: "gpu0", group: "gpu0", kind: "gpu",
                                   deviceTotal: true, watts: 54 }]);
    Harness.equal(one.watts, 54, "the one card");
    Harness.equal(one.source, "gpu", "and it says so");

    let two = Reading.pickPower(null, null,
                                [{ id: "gpu0", group: "gpu0", kind: "gpu",
                                   deviceTotal: true, watts: 54 },
                                 { id: "gpu1", group: "gpu1", kind: "gpu",
                                   deviceTotal: true, watts: 20 }]);
    Harness.equal(two.watts, 74, "two cards are added together");

    let none = Reading.pickPower(null, null, [{ kind: "battery", watts: 9 }]);
    Harness.equal(none.watts, null, "and a meter that is not a card is not the machine");
};
