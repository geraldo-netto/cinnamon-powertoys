/*
 * power-profiles-daemon, against a stubbed system bus.
 *
 * The bus is a parameter now, so these run on a machine with no system bus at
 * all - which is what CI is. What ran before was live.js, which skips itself
 * where there is no daemon, so on the runner this module had never been
 * exercised beyond being loaded.
 *
 * The two are not the same test and both are wanted: live.js says the
 * interface XML still matches a real daemon, and these say what this module
 * makes of what a daemon says. The second is where the unpacking lives, and
 * unpacking a variant wrongly is exactly the sort of thing that reads as an
 * empty profile list and nothing else.
 */

const Harness = imports.harness;

const Profiles = Harness.requireXlet("./lib/profiles.js");

const HADESS = "net.hadess.PowerProfiles";
const UPOWER = "org.freedesktop.UPower.PowerProfiles";

/* A value the way a proxy wrapper hands it over: a variant to be unpacked.
 * The daemon's own properties arrive as these, and a plain string arrives
 * where the wrapper has already done it, so both have to work. */
function variant(value) {
    return { unpack: () => value, deepUnpack: () => value };
}

/*
 * A daemon. `profiles` is the list it offers, `active` the one in force.
 * Reads of Profiles are counted, which is how the caching in snapshot() is
 * checked without reaching inside it.
 */
function daemon(overrides) {
    let settings = overrides || {};
    let stub = {
        reads: 0,
        handlers: [],
        ActiveProfile: settings.active === undefined ? "balanced" : settings.active,
        PerformanceDegraded: settings.degraded === undefined ? "" : settings.degraded,
        PerformanceInhibited: settings.inhibited === undefined ? "" : settings.inhibited,
        ActiveProfileHolds: settings.holds || [],
        connect: function (name, handler) {
            stub.handlers.push([name, handler]);
            return stub.handlers.length;
        },
        disconnect: function (id) {
            stub.disconnected = id;
        },
    };
    let list = settings.profiles === undefined
        ? [{ Profile: variant("power-saver") }, { Profile: variant("balanced") },
           { Profile: "performance" }]
        : settings.profiles;
    Object.defineProperty(stub, "Profiles", { get: function () {
        stub.reads++;
        return list;
    } });
    return stub;
}

/*
 * A system bus carrying whichever daemons are given, keyed by bus name. A
 * name that is absent throws when a proxy for it is asked for, which is what
 * makeProxyWrapper does against a name nobody owns.
 *
 * The proxy is asked for with a callback, because the real one is built
 * asynchronously - see systemBus() - and this stub answers it straight away.
 * That is what keeps these cases ordinary functions: the connecting is
 * asynchronous in shape and immediate in fact, so everything below still reads
 * as a sequence. The cases that care about the gap hold the callback instead.
 */
function bus(daemons) {
    let watched = [];
    let writes = [];
    let stub = {
        watched: watched,
        writes: writes,
        unwatched: [],
        failWrite: null,
        proxy: function (backend, onDone) {
            if (!daemons[backend.name])
                throw new Error("no owner for " + backend.name);
            onDone(daemons[backend.name], null);
        },
        watch: function (name, onAppeared, onVanished) {
            watched.push({ name: name, appeared: onAppeared, vanished: onVanished });
            return watched.length;
        },
        unwatch: function (id) {
            stub.unwatched.push(id);
        },
        setProperty: function (name, path, property, value, onDone) {
            writes.push([name, path, property, value]);
            onDone(stub.failWrite);
        },
    };
    return stub;
}

var cases = {};

cases["the daemon is found under either of the two names"] = function () {
    let old = new Profiles.PowerProfilesClient(null, bus({ [HADESS]: daemon() }));
    Harness.equal(old.available, true, "0.13 and older");
    Harness.equal(old.busName, HADESS, "under its own name");

    let recent = new Profiles.PowerProfilesClient(null, bus({ [UPOWER]: daemon() }));
    Harness.equal(recent.available, true, "0.20 and newer");
    Harness.equal(recent.busName, UPOWER, "under the name it moved to");
};

cases["a name that offers no profiles is passed over"] = function () {
    /* The name is owned and the object answers, but there is nothing on it -
     * which is not a daemon this applet can use, and is not a reason to stop
     * looking at the other name. */
    let client = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ profiles: [] }),
        [UPOWER]: daemon(),
    }));
    Harness.equal(client.busName, UPOWER, "kept looking");
    Harness.equal(client.available, true, "and found one");
};

cases["the caller is told once the daemon has answered"] = function () {
    /*
     * The whole of why connecting is asynchronous. The bus is no longer asked
     * on the thread that draws, which means `available` is false when the
     * constructor returns - so a client that found a daemon a moment later and
     * said nothing would leave the applet with the answer it took at startup,
     * and the menu without a profile control until something unrelated
     * redrew it.
     */
    let stub = daemon();
    let system = bus({ [HADESS]: stub });
    let waiting = [];
    system.proxy = function (backend, onDone) {
        if (backend.name !== HADESS)
            throw new Error("no owner for " + backend.name);
        waiting.push(() => onDone(stub, null));
    };

    let changes = 0;
    let client = new Profiles.PowerProfilesClient(() => changes++, system);
    Harness.equal(client.available, false, "the bus has not answered yet");
    Harness.equal(changes, 0, "and there is nothing to say until it has");

    waiting.shift()();
    Harness.equal(client.available, true, "it answered");
    Harness.equal(client.busName, HADESS, "under its own name");
    Harness.equal(changes, 1, "and the caller was told, which is how the menu finds out");
};

cases["a name that answers with an error is passed over"] = function () {
    /* Asked asynchronously, a name nobody owns reports its failure to the
     * callback rather than throwing it. Either way the other name is still
     * worth trying. */
    let stub = daemon();
    let asked = [];
    let system = bus({ [UPOWER]: stub });
    system.proxy = function (backend, onDone) {
        asked.push(backend.name);
        if (backend.name === UPOWER)
            onDone(stub, null);
        else
            onDone(null, new Error("no owner for " + backend.name));
    };

    let client = new Profiles.PowerProfilesClient(null, system);
    Harness.deepEqual(asked, [HADESS, UPOWER], "asked in order, and kept going past the failure");
    Harness.equal(client.busName, UPOWER, "and connected to the one that answered");
};

cases["a daemon that answers after the client is gone is not connected to"] = function () {
    let stub = daemon();
    let system = bus({ [HADESS]: stub });
    let waiting = [];
    system.proxy = function (backend, onDone) {
        if (backend.name !== HADESS)
            throw new Error("no owner for " + backend.name);
        waiting.push(() => onDone(stub, null));
    };

    let client = new Profiles.PowerProfilesClient(null, system);
    client.destroy();
    waiting.shift()();
    Harness.equal(client.available, false, "the applet has left the panel; what it found is no use");
    Harness.equal(stub.handlers.length, 0, "and nothing was connected to outlive it");
};

cases["a machine with no daemon reads as unavailable"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({}));
    Harness.equal(client.available, false, "no daemon");
    Harness.equal(client.busName, null, "and no name to report");
    Harness.deepEqual(client.profiles, [], "an empty list, not a throw");
    Harness.equal(client.active, null, "and nothing in force");
    Harness.equal(client.degraded, "", "a string, because the menu prints it");
    Harness.deepEqual(client.holds, [], "and a list, because the menu walks it");
};

cases["profile names are unpacked out of the daemon's dictionaries"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({ [HADESS]: daemon() }));
    Harness.deepEqual(client.profiles, ["power-saver", "balanced", "performance"],
                      "variants unpacked, and a plain string left alone");
};

cases["an entry that names no profile is dropped rather than listed as nothing"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ profiles: [{ Profile: variant("balanced") }, { Driver: variant("x") }] }),
    }));
    Harness.deepEqual(client.profiles, ["balanced"], "only the one that said what it was");
};

cases["a hold names the application and the profile it is holding"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ holds: [{ ApplicationId: variant("steam"),
                                     Profile: variant("performance"),
                                     Reason: variant("a game is running") }] }),
    }));
    Harness.deepEqual(client.holds,
                      [{ application: "steam", profile: "performance",
                         reason: "a game is running" }],
                      "each field out of its own variant");
};

cases["degraded falls back to inhibited"] = function () {
    let newer = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ degraded: "lap-detected", inhibited: "high-operating-temperature" }),
    }));
    Harness.equal(newer.degraded, "lap-detected", "the newer property wins where it says anything");

    let older = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ degraded: "", inhibited: "high-operating-temperature" }),
    }));
    Harness.equal(older.degraded, "high-operating-temperature",
                  "and the older one is read where it does not");
};

cases["a whole reading comes from one look at the daemon"] = function () {
    let stub = daemon();
    let client = new Profiles.PowerProfilesClient(null, bus({ [HADESS]: stub }));
    let after = stub.reads;

    client.snapshot();
    client.snapshot();
    client.snapshot();
    Harness.equal(stub.reads - after, 1,
                  "unpacking the list was the largest single cost in a poll");
};

cases["the daemon speaking drops the reading and says so"] = function () {
    let stub = daemon();
    let changes = 0;
    let client = new Profiles.PowerProfilesClient(() => changes++, bus({ [HADESS]: stub }));
    /* Finding the daemon is itself a change, and this stub answers at once;
     * what is counted here is what the daemon says afterwards. */
    let connected = changes;

    Harness.equal(client.snapshot().active, "balanced", "as it was");
    stub.ActiveProfile = "performance";
    Harness.equal(client.snapshot().active, "balanced", "still, until the daemon says otherwise");

    stub.handlers.find(entry => entry[0] === "g-properties-changed")[1]();
    Harness.equal(changes - connected, 1, "the caller hears about it");
    Harness.equal(client.snapshot().active, "performance", "and the reading is taken again");
};

cases["setting a profile reports what the daemon answered"] = function () {
    let system = bus({ [HADESS]: daemon() });
    let client = new Profiles.PowerProfilesClient(null, system);

    let outcome = "not called";
    client.setProfile("performance", error => { outcome = error; });
    Harness.deepEqual(system.writes,
                      [[HADESS, "/net/hadess/PowerProfiles", "ActiveProfile", "performance"]],
                      "written as a property on the daemon's own interface");
    Harness.equal(outcome, null, "accepted");

    system.failWrite = new Error("polkit said no");
    client.setProfile("power-saver", error => { outcome = error; });
    Harness.equal(outcome.message, "polkit said no",
                  "the refusal reaches the caller, which is the whole reason Set is issued here");
};

cases["setting a profile with no daemon answers rather than throwing"] = function () {
    let system = bus({});
    let client = new Profiles.PowerProfilesClient(null, system);

    let outcome = null;
    Harness.equal(client.setProfile("performance", error => { outcome = error; }), false, "refused");
    Harness.ok(outcome && outcome.message, "with a reason");
    Harness.deepEqual(system.writes, [], "and nothing went out");
};

cases["a daemon appearing is connected to, and one vanishing is let go"] = function () {
    let daemons = {};
    let system = bus(daemons);
    let changes = 0;
    let client = new Profiles.PowerProfilesClient(() => changes++, system);
    Harness.equal(client.available, false, "nothing there when it started");
    Harness.deepEqual(system.watched.map(entry => entry.name), [HADESS, UPOWER],
                      "both names are watched, since either may turn up");

    daemons[UPOWER] = daemon();
    system.watched.find(entry => entry.name === UPOWER).appeared();
    Harness.equal(client.available, true, "connected on the way in");
    Harness.equal(changes, 1, "and the applet is told to look again");

    system.watched.find(entry => entry.name === UPOWER).vanished();
    Harness.equal(client.available, false, "let go on the way out");
    Harness.equal(client.busName, null, "with no name left behind");
    Harness.equal(changes, 2, "and told again");
};

cases["a destroyed client unwatches both names"] = function () {
    let stub = daemon();
    let system = bus({ [HADESS]: stub });
    let client = new Profiles.PowerProfilesClient(null, system);
    client.destroy();

    Harness.deepEqual(system.unwatched, [1, 2], "both watches, or they outlive the applet");
    Harness.equal(stub.disconnected, 1, "and the property handler with them");
    Harness.equal(client.available, false, "nothing answers afterwards");
};
