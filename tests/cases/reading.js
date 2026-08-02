/*
 * What one reading of the machine comes to.
 *
 * These were free functions at the top of applet.js, which no case can load,
 * so nothing here had ever been checked - including profileOwnsGovernor, which
 * decides whether the governor is a control or a readout and is the single
 * largest thing the menu does differently from one machine to the next.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const PowerSupply = Harness.requireXlet("./lib/power-supply.js");
const Reading = Harness.requireXlet("./lib/reading.js");

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
    /* Three different measurements of three different things, and a bare
     * number would read as the machine's draw whichever it was. */
    Harness.equal(Reading.powerText(power(8.4, "battery")), "8.4 W (battery)", "battery");
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
        Reading.profileOwnsGovernor(profile({ backend: PowerSupply.PLATFORM_BACKEND })),
        false, "ACPI writes firmware, not cpufreq");
};

cases["a machine with no profiles does not own the governor either"] = function () {
    Harness.equal(Reading.profileOwnsGovernor(profile({ available: false })), false,
                  "nothing is writing it");
    Harness.equal(Reading.profileOwnsGovernor(profile({ backend: null })), false,
                  "and nothing claims to be");
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
    let picked = Reading.pickTemperature([NVME, AMDGPU, CCD, K10], "");
    Harness.equal(picked.sensor.rawLabel, "Tctl",
                  "the one AMD publishes as the package's control value");
    Harness.equal(picked.hintMatched, null, "nobody asked for a particular one");
};

cases["the preference order is followed, not the discovery order"] = function () {
    /* Tccd1 comes off the same chip and is discovered first here; it is one
     * chiplet, not the package. */
    Harness.equal(Reading.pickTemperature([CCD, TDIE], "").sensor.rawLabel, "Tdie", "Tdie over Tccd1");
    Harness.equal(Reading.pickTemperature([CCD, TDIE, K10], "").sensor.rawLabel, "Tctl",
                  "and Tctl over Tdie");
};

cases["a processor with nothing recognisable still answers"] = function () {
    let odd = temperature("soc_thermal", null, "cpu", 55.0);
    Harness.equal(Reading.pickTemperature([AMDGPU, odd], "").sensor.chip, "soc_thermal",
                  "any CPU sensor beats a GPU one");
};

cases["a machine with no processor sensor falls back to the graphics card"] = function () {
    Harness.equal(Reading.pickTemperature([NVME, AMDGPU], "").sensor.chip, "amdgpu", "the GPU");
    Harness.equal(Reading.pickTemperature([NVME], "").sensor.chip, "nvme",
                  "and then to whatever there is, rather than to nothing");
};

cases["a machine that reports nothing readable says so"] = function () {
    let dead = temperature("amdgpu", "edge", "gpu", null);
    let picked = Reading.pickTemperature([dead], "");
    Harness.equal(picked.sensor, null, "no sensor");
    Harness.equal(picked.hintMatched, null, "and no hint to have failed");
};

cases["a hint chooses the sensor, whatever kind it is"] = function () {
    /* Matched on what the driver calls it, so a disk can be named on purpose
     * and the sensor filter keeps it for that reason. */
    let picked = Reading.pickTemperature([K10, AMDGPU, NVME], "nvme");
    Harness.equal(picked.sensor.chip, "nvme", "the one that was asked for");
    Harness.equal(picked.hintMatched, true, "and it was found");
};

cases["a hint is matched on the driver's word, not the menu's"] = function () {
    Harness.equal(Reading.pickTemperature([K10, AMDGPU], "Tctl").sensor.rawLabel, "Tctl",
                  "the label");
    Harness.equal(Reading.pickTemperature([K10, AMDGPU], "amdgpu").sensor.chip, "amdgpu",
                  "or the chip");
};

cases["a hint that matches nothing is reported, not swallowed"] = function () {
    /* Somebody who typed a name has no other way of finding out it was
     * ignored, so the menu says so - which it can only do because of this. */
    let picked = Reading.pickTemperature([K10, AMDGPU], "coretemp");
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

cases["the package counter comes before the graphics card"] = function () {
    Harness.deepEqual(Reading.pickPower(null, 54, [{ kind: "gpu", watts: 30 }]),
                      { watts: 54, source: "package" }, "RAPL where it can be read");
};

cases["graphics cards are added together when there is nothing else"] = function () {
    let powers = [{ kind: "gpu", watts: 30 }, { kind: "gpu", watts: 24 },
                  { kind: "cpu", watts: 19 }];
    Harness.deepEqual(Reading.pickPower(null, null, powers), { watts: 54, source: "gpu" },
                      "both cards, and nothing that is not one");
};

cases["a machine that measures no power says so rather than showing a zero"] = function () {
    Harness.deepEqual(Reading.pickPower(null, null, []), { watts: null, source: null },
                      "nothing measured is not nought watts");
};
