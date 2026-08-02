/*
 * What one reading of the machine comes to.
 *
 * These were free functions at the top of applet.js, which no case can load,
 * so nothing here had ever been checked - including profileOwnsGovernor, which
 * decides whether the governor is a control or a readout and is the single
 * largest thing the menu does differently from one machine to the next.
 */

const Harness = imports.harness;

const PowerSupply = Harness.requireXlet("./lib/power-supply.js");
const Reading = Harness.requireXlet("./lib/reading.js");

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
