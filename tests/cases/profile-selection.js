/*
 * Which of the two profile writers answers, and since when.
 *
 * The generation is the whole point of these cases: the same daemon client is
 * re-used when its bus name changes owner, so a reply in flight across that
 * moment has to be told apart from one that belongs to the writer in use.
 */

const Harness = imports.harness;

const ProfileSelection = Harness.requireXlet("./lib/profile-selection.js");

function client(name, available, state) {
    return {
        name: name,
        available: available,
        snapshot: () => state || {
            available: available,
            busName: name,
            active: "balanced",
            profiles: ["balanced", "performance"],
            degraded: "",
            holds: [],
        },
    };
}

function selection(daemon, platform) {
    let state = { forgotten: 0 };
    state.daemon = daemon;
    state.platform = platform;
    state.selection = new ProfileSelection.ProfileSelection(
        daemon, platform, () => { state.forgotten++; });
    return state;
}

var cases = {};

cases["the daemon answers wherever it is running"] = function () {
    let state = selection(client("ppd", true), client("acpi", true));

    Harness.equal(state.selection.choose(), true, "the first choice is a move");
    Harness.equal(state.selection.backend, state.daemon,
                  "power-profiles-daemon is preferred to the firmware");
    Harness.equal(state.selection.isPlatform, false,
                  "so no write of it needs the privileged helper");
    Harness.equal(state.selection.choose(), false, "asking again is not a move");
    Harness.equal(state.forgotten, 1, "and nothing is let go of twice");
};

cases["the firmware answers where the daemon does not"] = function () {
    let state = selection(client("ppd", false), client("acpi", true));

    state.selection.choose();
    Harness.equal(state.selection.backend, state.platform,
                  "a vendor module loaded after login is still found");
    Harness.equal(state.selection.isPlatform, true,
                  "which the menu has to know: every write of it is privileged");
};

cases["a machine with neither still reads as a machine with no profiles"] = function () {
    let state = selection(client("ppd", false), client("acpi", false));

    state.selection.choose();
    Harness.equal(state.selection.backend, state.daemon,
                  "the daemon client answers unavailable, null and an empty list");
    Harness.equal(state.selection.isPlatform, false, "and it is not the firmware");
};

cases["the daemon arriving is a move, not the same client twice"] = function () {
    let daemon = client("ppd", false);
    let state = selection(daemon, client("acpi", false));
    state.selection.choose();
    let first = state.selection.generation;

    daemon.available = true;
    Harness.equal(state.selection.choose(), true,
                  "the same object becoming available is a different writer");
    Harness.ok(state.selection.generation > first, "so the generation moves");
    Harness.equal(state.forgotten, 2, "and what was asked of the old one is dropped");
};

cases["work started against a writer that has gone is not presented"] = function () {
    let daemon = client("ppd", true);
    let state = selection(daemon, client("acpi", true));
    state.selection.choose();
    let backend = state.selection.backend;
    let generation = state.selection.generation;

    Harness.equal(state.selection.stillOwned(backend, generation), true,
                  "a reply from the writer in use lands");

    /* The daemon goes away and comes back: the same object, a different owner. */
    daemon.available = false;
    state.selection.choose();
    daemon.available = true;
    state.selection.choose();

    Harness.equal(state.selection.backend, backend, "the same client is re-used");
    Harness.equal(state.selection.stillOwned(backend, generation), false,
                  "but a reply from before the change of owner is not its answer");
    Harness.equal(state.selection.stillOwned(backend, state.selection.generation), true,
                  "while one from after it is");
};

cases["the snapshot carries the owner it was taken from"] = function () {
    let daemon = client("ppd", true, {
        available: true,
        busName: "net.hadess.PowerProfiles",
        active: "performance",
        profiles: ["balanced", "performance"],
        degraded: "high-operating-temperature",
        holds: [{ application: "Firefox", profile: "performance" }],
    });
    let state = selection(daemon, client("acpi", false));
    state.selection.choose();

    let taken = state.selection.snapshot(state.selection.backend,
                                         state.selection.generation);
    Harness.equal(taken.backend, "net.hadess.PowerProfiles", "the writer names itself");
    Harness.equal(taken.active, "performance", "what it reports is what is drawn");
    Harness.deepEqual(taken.list, ["balanced", "performance"], "with the choice it offers");
    Harness.equal(taken.degraded, "high-operating-temperature", "and why it is limited");
    Harness.equal(taken.source, state.daemon, "the owner rides along");
    Harness.equal(taken.generation, state.selection.generation, "with its generation");
};

cases["teardown owns nothing afterwards"] = function () {
    let state = selection(client("ppd", true), client("acpi", true));
    state.selection.choose();
    let backend = state.selection.backend;
    let generation = state.selection.generation;

    state.selection.release();
    Harness.equal(state.selection.backend, null, "the choice is let go of");
    Harness.equal(state.selection.stillOwned(backend, generation), false,
                  "so a reply that arrives after the applet has gone lands nowhere");
};
