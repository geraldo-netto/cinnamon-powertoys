/*
 * What is made of a profile reading.
 *
 * These three answers used to live inside the methods that acted on them, so
 * nothing could ask them anything: what the menu draws, whether the block may
 * be stepped at all, and whether a reply still belongs to the writer that
 * started it. The acting is still in the applet and the menu; the deciding is
 * here, and this is where it is held to.
 */

const Harness = imports.harness;

const ProfileView = Harness.requireXlet("./lib/profile-view.js");
const PowerSupply = Harness.requireXlet("./lib/power-supply.js");

/* The one backend whose writes go through pkexec, and so through the
 * privileged-controls setting. */
const PLATFORM = PowerSupply.PLATFORM_BACKEND;

function reading(profile, parts) {
    return Object.assign({
        upowerAvailable: true,
        onBattery: false,
        primary: null,
        cpu: { governor: null, driver: null, ownedByProfile: false },
        profile: Object.assign({
            available: true,
            active: "balanced",
            list: ["power-saver", "balanced", "performance"],
            degraded: null,
            holds: [],
            source: null,
            generation: 0,
            backend: "net.hadess.PowerProfiles",
        }, profile || {}),
    }, parts || {});
}

function options(parts) {
    return Object.assign({
        showProfiles: true,
        profilePrivileged: true,
        pendingProfile: null,
    }, parts || {});
}

var cases = {};

/* ------------------------------------------------------------------ */
/* who a snapshot belongs to                                            */

cases["a snapshot belongs to the backend and the generation it came from"] = function () {
    let daemon = {};
    Harness.equal(ProfileView.sameOwner({ source: daemon, generation: 3 }, daemon, 3), true,
                  "the same writer at the same generation");
    Harness.equal(ProfileView.sameOwner({ source: daemon, generation: 3 }, daemon, 4), false,
                  "the same daemon after its bus name changed hands is not the same writer");
    Harness.equal(ProfileView.sameOwner({ source: daemon, generation: 3 }, {}, 3), false,
                  "and another backend at the same generation is not it either");
    Harness.equal(ProfileView.sameOwner(null, daemon, 3), false,
                  "nothing belongs to nobody");
};

/* ------------------------------------------------------------------ */
/* what the menu draws                                                  */

cases["a list of several profiles is drawn as a choice"] = function () {
    let view = ProfileView.menuView(reading(), options());
    Harness.equal(view.show, true, "the group is shown");
    Harness.equal(view.showChoices, true, "as segments");
    Harness.equal(view.single, false, "which is not the single-value shape");
    Harness.deepEqual(view.choices, ["power-saver", "balanced", "performance"],
                      "with every profile the backend offers");
    Harness.equal(view.active, "balanced", "and the one in force filled");
    Harness.equal(view.valueText, "", "the value row says nothing, because it is not shown");
};

cases["a list of one profile is a reading rather than a choice"] = function () {
    let view = ProfileView.menuView(reading({ active: "performance",
                                              list: ["performance"] }), options());
    Harness.equal(view.single, true, "one value is not a list");
    Harness.equal(view.showChoices, false,
                  "so no control claims a say the user has not got");
    Harness.deepEqual(view.choices, [], "and there is nothing to sync into one");
    Harness.ok(view.valueText !== "", "the value is still worth reading: " + view.valueText);
};

cases["the filled segment follows what was asked for"] = function () {
    /* Not what has arrived: a selection that springs back while the daemon
     * thinks about it reads as the click having missed. */
    let view = ProfileView.menuView(reading(), options({ pendingProfile: "performance" }));
    Harness.equal(view.active, "performance", "the pending choice is the one shown");
};

cases["a group with nothing behind it is not shown"] = function () {
    Harness.equal(ProfileView.menuView(reading({ available: false }), options()).show, false,
                  "an unavailable backend");
    Harness.equal(ProfileView.menuView(reading({ list: [] }), options()).show, false,
                  "a backend offering nothing");
    Harness.equal(ProfileView.menuView(reading(), options({ showProfiles: false })).show, false,
                  "and a group the user switched off");
};

cases["a hidden group draws neither degradation nor holds"] = function () {
    let view = ProfileView.menuView(
        reading({ degraded: "high-operating-temperature",
                  holds: [{ application: "Firefox", profile: "performance" }] }),
        options({ showProfiles: false }));
    Harness.equal(view.degradedText, "", "nothing is said about a group that is not there");
    Harness.equal(view.holdsText, "", "including its holds");
};

cases["degradation and holds are separate lines"] = function () {
    /* Degradation is a hardware constraint; a hold is an application asking
     * for something. Both under one warning made a performance request read
     * as though performance had been limited. */
    let view = ProfileView.menuView(
        reading({ degraded: "high-operating-temperature",
                  holds: [{ application: "Firefox", profile: "performance" }] }),
        options());
    Harness.ok(view.degradedText !== "", "the constraint is stated: " + view.degradedText);
    Harness.ok(view.holdsText.indexOf("Firefox") >= 0,
               "and the request separately: " + view.holdsText);
    Harness.equal(view.degradedText.indexOf("Firefox"), -1, "the two are not one line");
};

cases["every hold is named, and an anonymous one still counts"] = function () {
    let view = ProfileView.menuView(reading({ holds: [
        { application: "Firefox", profile: "performance" },
        { application: "", profile: "power-saver" },
    ] }), options());
    Harness.equal(view.holdsText.split(", ").length, 2, "both holds are listed");
    Harness.ok(view.holdsText.indexOf("Firefox") >= 0, "the one that said who it is");
    Harness.ok(view.holdsText.length > "Firefox".length,
               "and the one that did not is still described: " + view.holdsText);
};

cases["a machine with nothing degraded and nothing held says neither"] = function () {
    let view = ProfileView.menuView(reading(), options());
    Harness.equal(view.degradedText, "", "no degradation line");
    Harness.equal(view.holdsText, "", "no holds line");
};

cases["what may be changed is what the reading allows"] = function () {
    Harness.equal(ProfileView.menuView(reading(), options()).editable, true,
                  "an unprivileged daemon is writable");
    Harness.equal(ProfileView.menuView(reading(), options({ profilePrivileged: false }))
                      .editable, true,
                  "and stays writable, because it asks for no password");
    let firmware = reading({ backend: PLATFORM });
    Harness.equal(ProfileView.menuView(firmware, options()).editable, true,
                  "the firmware profile is writable while privileged changes are allowed");
    Harness.equal(ProfileView.menuView(firmware, options({ profilePrivileged: false }))
                      .editable, false,
                  "and not when they are not");
};

/* ------------------------------------------------------------------ */
/* what may be stepped                                                  */

function context(parts) {
    return Object.assign({
        backend: null,
        generation: 0,
        platformProfiles: {},
        busy: false,
        privileged: true,
    }, parts || {});
}

cases["a profile block from the current writer can be stepped"] = function () {
    let daemon = {};
    let data = reading({ source: daemon, generation: 2 });
    Harness.equal(ProfileView.steppableState(data, context({ backend: daemon, generation: 2 })),
                  data.profile, "the snapshot itself is given back");
};

cases["nothing to choose from cannot be stepped"] = function () {
    let daemon = {};
    let base = context({ backend: daemon, generation: 2 });
    Harness.equal(ProfileView.steppableState(null, base), null, "no reading yet");
    Harness.equal(ProfileView.steppableState(
        reading({ available: false, source: daemon, generation: 2 }), base), null,
        "an unavailable backend");
    Harness.equal(ProfileView.steppableState(
        reading({ list: [], source: daemon, generation: 2 }), base), null,
        "and an empty list");
};

cases["a snapshot from a previous owner cannot be stepped"] = function () {
    let daemon = {};
    Harness.equal(ProfileView.steppableState(
        reading({ source: daemon, generation: 1 }),
        context({ backend: daemon, generation: 2 })), null,
        "controls from the previous generation are refused immediately");
    Harness.equal(ProfileView.steppableState(
        reading({ source: daemon, generation: 2 }),
        context({ backend: {}, generation: 2 })), null,
        "and so are controls from another backend");
};

cases["the firmware profile waits for the dialog already on screen"] = function () {
    let firmware = {};
    let data = reading({ source: firmware, generation: 5 });
    let base = { backend: firmware, generation: 5, platformProfiles: firmware,
                 privileged: true };
    Harness.equal(ProfileView.steppableState(data, Object.assign({ busy: true }, base)), null,
                  "a second password dialog is not queued behind the first");
    Harness.equal(ProfileView.steppableState(data, Object.assign({ busy: false }, base)),
                  data.profile, "and it returns as soon as the helper is free");
};

cases["an unprivileged daemon stays responsive while the helper is busy"] = function () {
    let daemon = {};
    let data = reading({ source: daemon, generation: 5 });
    Harness.equal(ProfileView.steppableState(data, context({
        backend: daemon, generation: 5, platformProfiles: {}, busy: true,
    })), data.profile, "the daemon needs no authentication, so nothing is waiting");
};

cases["a control the user has not allowed cannot be stepped"] = function () {
    let firmware = {};
    let data = reading({ backend: PLATFORM, source: firmware, generation: 5 });
    Harness.equal(ProfileView.steppableState(data, context({
        backend: firmware, generation: 5, platformProfiles: firmware, privileged: false,
    })), null, "the wheel stops at the same gate as the menu segment");
};

cases["a profile changed where nobody was looking says so"] = function () {
    Harness.equal(ProfileView.announcement("performance"),
                  "Power profile: Performance",
                  "the wheel, the hotkey and the middle click leave no other trace");
};
