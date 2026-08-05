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

const Fuzz = imports.fuzz;
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
        Version: settings.version === undefined ? "0.23" : settings.version,
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
        cancellables: [],
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
        cancellable: function () {
            let token = { cancelled: false, cancel: function () { token.cancelled = true; } };
            stub.cancellables.push(token);
            return token;
        },
        setProperty: function (name, path, property, value, cancellable, onDone) {
            writes.push([name, path, property, value]);
            onDone(stub.failWrite);
        },
    };
    return stub;
}

/* A production-shaped name watcher: each registration immediately reports
 * whether its name is currently owned. This is the contract Gio documents
 * and the optimization under test; the simpler bus() intentionally retains
 * the integration fallback where watchers only report later edges. */
function ownerBus(daemons) {
    let system = bus(daemons);
    let originalProxy = system.proxy;
    system.watchReportsInitialState = true;
    system.asked = [];
    system.proxy = function (backend, onDone, cancellable) {
        system.asked.push(backend.name);
        originalProxy(backend, onDone, cancellable);
    };
    system.watch = function (name, onAppeared, onVanished) {
        system.watched.push({ name: name, appeared: onAppeared, vanished: onVanished });
        if (Object.prototype.hasOwnProperty.call(daemons, name))
            onAppeared();
        else
            onVanished();
        return system.watched.length;
    };
    return system;
}

function retryTimers(system) {
    let timers = { next: 1, pending: {}, delays: [], removed: [] };
    system.timeoutAdd = function (delay, callback) {
        let id = timers.next++;
        timers.pending[id] = callback;
        timers.delays.push(delay);
        return id;
    };
    system.removeTimer = function (id) {
        timers.removed.push(id);
        delete timers.pending[id];
    };
    timers.fire = function () {
        let ids = Object.keys(timers.pending);
        Harness.equal(ids.length, 1, "exactly one profile retry is pending");
        let id = Number(ids[0]);
        let callback = timers.pending[id];
        delete timers.pending[id];
        callback();
    };
    return timers;
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

cases["only names reported as owned are probed at startup"] = function () {
    let recentBus = ownerBus({ [UPOWER]: daemon() });
    let recent = new Profiles.PowerProfilesClient(null, recentBus);
    Harness.deepEqual(recentBus.asked, [UPOWER], "the absent legacy name costs no proxy call");
    Harness.equal(recent.busName, UPOWER, "the owned backend is selected");

    let noneBus = ownerBus({});
    let none = new Profiles.PowerProfilesClient(null, noneBus);
    Harness.deepEqual(noneBus.asked, [], "no owner means no blind D-Bus probes");
    Harness.equal(none.available, false, "and the result remains unavailable");

    recent.destroy();
    none.destroy();
};

cases["the highest-priority owned profile name wins"] = function () {
    let daemons = { [HADESS]: daemon(), [UPOWER]: daemon({ active: "performance" }) };
    let system = ownerBus(daemons);
    let client = new Profiles.PowerProfilesClient(null, system);

    Harness.deepEqual(system.asked, [HADESS], "one successful preferred proxy is enough");
    Harness.equal(client.busName, HADESS, "the established priority is preserved");

    delete daemons[HADESS];
    system.watched.find(entry => entry.name === HADESS).vanished();
    Harness.equal(client.busName, UPOWER, "owner loss falls through to the live alternate");

    daemons[HADESS] = daemon({ active: "power-saver" });
    system.watched.find(entry => entry.name === HADESS).appeared();
    Harness.equal(client.busName, HADESS, "a returning preferred owner replaces the fallback");
    client.destroy();
};

cases["owned profile discovery failures retry with capped backoff"] = function () {
    let daemons = { [HADESS]: daemon() };
    let system = ownerBus(daemons);
    let timers = retryTimers(system);
    let failures = 7;
    let attempts = 0;
    system.proxy = function (backend, onDone) {
        system.asked.push(backend.name);
        attempts++;
        if (failures-- > 0)
            onDone(null, new Error("proxy timeout"));
        else
            onDone(daemons[backend.name], null);
    };
    let client = new Profiles.PowerProfilesClient(null, system);

    for (let i = 0; i < 6; i++)
        timers.fire();
    Harness.deepEqual(timers.delays, [500, 1000, 2000, 4000, 8000, 8000],
                      "profile retry delay doubles only to its cap");
    Harness.equal(attempts, 8, "the owned backend is retried until it recovers");
    Harness.equal(client.busName, HADESS, "the recovered proxy is adopted");
    Harness.equal(Object.keys(timers.pending).length, 0, "success leaves no retry armed");
    Harness.equal(client._retryDelay, Profiles.RETRY_INITIAL_MS,
                  "success resets backoff for another incident");
    client.destroy();
};

cases["an owned profile proxy with no usable profiles is retried"] = function () {
    let good = daemon();
    let system = ownerBus({ [HADESS]: good });
    let timers = retryTimers(system);
    let attempts = 0;
    system.proxy = function (backend, onDone) {
        attempts++;
        onDone(attempts <= 2 ? daemon({ profiles: [] }) : good, null);
    };
    let client = new Profiles.PowerProfilesClient(null, system);

    Harness.equal(Object.keys(timers.pending).length, 1,
                  "an unusable initial property set arms retry");
    timers.fire();
    Harness.equal(client.available, true, "a usable property set is adopted later");
    Harness.equal(attempts, 3, "the still-owned name was probed again");
    client.destroy();
};

cases["profile discovery retry is cancelled on owner changes and teardown"] = function () {
    let daemons = { [HADESS]: daemon() };
    let system = ownerBus(daemons);
    let timers = retryTimers(system);
    system.proxy = function (backend, onDone) {
        onDone(null, new Error("proxy timeout"));
    };
    let client = new Profiles.PowerProfilesClient(null, system);
    let hadessWatch = system.watched.find(entry => entry.name === HADESS);
    Harness.equal(Object.keys(timers.pending).length, 1, "failure arms retry");

    delete daemons[HADESS];
    hadessWatch.vanished();
    Harness.equal(Object.keys(timers.pending).length, 0, "owner loss cancels it");
    daemons[HADESS] = daemon();
    hadessWatch.appeared();
    Harness.equal(Object.keys(timers.pending).length, 1,
                  "the replacement owner has a fresh discovery incident");
    client.destroy();
    Harness.equal(Object.keys(timers.pending).length, 0, "teardown cancels that retry too");
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

cases["an unwired profile proxy is passed over transactionally"] = function () {
    let broken = daemon();
    broken.connect = () => { throw new Error("property subscription failed"); };
    let fallback = daemon({ active: "performance" });
    let client = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: broken,
        [UPOWER]: fallback,
    }));

    Harness.equal(client.busName, UPOWER, "discovery continues to the usable backend");
    Harness.equal(client.active, "performance", "only the wired proxy is published");
    Harness.equal(client._proxy, fallback, "the failed candidate never becomes available");
    client.destroy();
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

cases["a failed name watch is probed instead of treated as absent"] = function () {
    let system = ownerBus({ [UPOWER]: daemon() });
    let watches = 0;
    system.watch = function (name, onAppeared, onVanished) {
        watches++;
        if (name === UPOWER)
            throw new Error("watch unavailable");
        system.watched.push({ name: name, appeared: onAppeared, vanished: onVanished });
        onVanished();
        return 41;
    };

    let client = new Profiles.PowerProfilesClient(null, system);
    Harness.equal(client.available, true, "the daemon behind the failed watch is discovered");
    Harness.equal(client.busName, UPOWER, "the failed watcher name was probed directly");
    Harness.deepEqual(system.asked, [UPOWER],
                      "confirmed absence stays skipped while unknown ownership is searched");
    Harness.deepEqual(system.watched.map(entry => entry.name), [HADESS],
                      "the successful watch remains active");
    client.destroy();
    Harness.deepEqual(system.unwatched, [41], "the partial watch set is still released");
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

cases["a hold with an absent field is still readable"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({
        [HADESS]: daemon({ holds: [{ ApplicationId: null,
                                     Profile: variant("performance"), Reason: null }] }),
    }));
    Harness.deepEqual(client.holds,
                      [{ application: "", profile: "performance", reason: "" }],
                      "null is absence, not a variant to unpack");
    client.destroy();
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

cases["profile write setup failures settle and release the queue"] = function () {
    let system = bus({ [HADESS]: daemon() });
    system.setProperty = () => { throw new Error("cannot start Set"); };
    let client = new Profiles.PowerProfilesClient(null, system);
    let error = null;
    Harness.equal(client.setProfile("performance", answer => { error = answer; }), false,
                  "the write reports it did not start");
    Harness.equal(error.message, "cannot start Set", "the setup failure reaches the caller");
    Harness.equal(client._setCall, null, "no in-flight call is stranded");
    Harness.equal(client._setQueued, null, "nor queued work");
    client.destroy();
};

cases["the profile write drain rejects unavailable and terminal states"] = function () {
    let client = new Profiles.PowerProfilesClient(null, bus({ [HADESS]: daemon() }));
    let outcome = null;
    client._setQueued = { name: "performance", cancellable: null,
                          done: error => { outcome = error; } };
    client._proxy = null;
    Harness.equal(client._drainProfileWrites(), false, "a lost proxy cannot start a write");
    Harness.ok(outcome && outcome.message, "the accepted request is still settled");

    client._setQueued = null;
    Harness.equal(client._drainProfileWrites(), false, "an empty queue is idle");
    client.destroyed = true;
    client._setQueued = { name: "balanced", done: () => {} };
    Harness.equal(client._drainProfileWrites(), false, "a destroyed client remains idle");
};

cases["profile writes serialize and retain only the latest request"] = function () {
    let system = bus({ [HADESS]: daemon() });
    let pending = [];
    system.setProperty = function (name, path, property, value, cancellable, onDone) {
        system.writes.push([name, path, property, value]);
        pending.push(onDone);
    };
    let client = new Profiles.PowerProfilesClient(null, system);
    let outcomes = [];

    client.setProfile("performance", error => outcomes.push(["performance", error]));
    client.setProfile("balanced", error => outcomes.push(["balanced", error]));
    client.setProfile("power-saver", error => outcomes.push(["power-saver", error]));

    Harness.deepEqual(system.writes.map(write => write[3]), ["performance"],
                      "only one D-Bus write is in flight");
    Harness.equal(outcomes.length, 1, "the displaced waiting caller settles immediately");
    Harness.equal(outcomes[0][0], "balanced", "the intermediate request was displaced");
    Harness.equal(outcomes[0][1], Profiles.PROFILE_SUPERSEDED,
                  "with the distinct superseded outcome");
    Harness.ok(!(outcomes[0][1] instanceof Error),
               "intentional coalescing is not reported as a failure");
    Harness.equal(Profiles.profileWriteError(outcomes[0][1]), null,
                  "so presentation code has no error to announce");

    let refusal = new Error("daemon refused the change");
    Harness.equal(Profiles.profileWriteError(refusal), refusal,
                  "real failures remain reportable");
    Harness.equal(Profiles.profileWriteError(null), null,
                  "and success remains success");

    pending.shift()(null);
    Harness.deepEqual(system.writes.map(write => write[3]),
                      ["performance", "power-saver"],
                      "the latest request follows the first one");
    Harness.equal(outcomes[1][0], "performance", "the first caller settles from its reply");

    pending.shift()(null);
    Harness.equal(outcomes[2][0], "power-saver", "the latest caller settles too");
    Harness.equal(outcomes[2][1], null, "with the daemon's successful result");
};

cases["setting a profile with no daemon answers rather than throwing"] = function () {
    let system = bus({});
    let client = new Profiles.PowerProfilesClient(null, system);

    let outcome = null;
    Harness.equal(client.setProfile("performance", error => { outcome = error; }), false, "refused");
    Harness.ok(outcome && outcome.message, "with a reason");
    Harness.deepEqual(system.writes, [], "and nothing went out");
};

cases["an in-flight profile write is cancelled at teardown"] = function () {
    let system = bus({ [HADESS]: daemon() });
    let finish = null;
    system.setProperty = function (name, path, property, value, cancellable, onDone) {
        finish = onDone;
    };
    let client = new Profiles.PowerProfilesClient(null, system);
    let completions = 0;
    client.setProfile("performance", () => completions++);

    client.destroy();
    Harness.equal(system.cancellables[system.cancellables.length - 1].cancelled, true,
                  "the D-Bus call is cancelled");
    finish(new Error("cancelled"));
    Harness.equal(completions, 0, "its late callback cannot reach the removed applet");
};

cases["an in-flight proxy search is cancelled at teardown"] = function () {
    let system = ownerBus({ [HADESS]: daemon() });
    let finish = null;
    let token = null;
    system.proxy = function (backend, onDone, cancellable) {
        system.asked.push(backend.name);
        finish = onDone;
        token = cancellable;
    };
    let client = new Profiles.PowerProfilesClient(null, system);

    Harness.ok(token, "the proxy initialization owns a cancellable");
    client.destroy();
    Harness.equal(token.cancelled, true, "teardown stops the pending bus work");
    finish(daemon(), null);
    Harness.equal(client.available, false, "the cancelled answer is not adopted");
};

cases["owner replacement cancels the old profile proxy search"] = function () {
    let daemons = { [HADESS]: daemon() };
    let system = ownerBus(daemons);
    let oldFinish = null;
    let oldToken = null;
    system.proxy = function (backend, onDone, cancellable) {
        system.asked.push(backend.name);
        if (backend.name === HADESS) {
            oldFinish = onDone;
            oldToken = cancellable;
        } else {
            onDone(daemons[backend.name], null);
        }
    };
    let client = new Profiles.PowerProfilesClient(null, system);

    delete daemons[HADESS];
    system.watched.find(entry => entry.name === HADESS).vanished();
    Harness.equal(oldToken.cancelled, true, "the vanished owner's search is cancelled");

    daemons[UPOWER] = daemon({ active: "performance" });
    system.watched.find(entry => entry.name === UPOWER).appeared();
    Harness.equal(client.busName, UPOWER, "the replacement owner is connected");
    oldFinish(daemon({ active: "power-saver" }), null);
    Harness.equal(client.busName, UPOWER, "the obsolete late answer cannot replace it");
    client.destroy();
};

cases["daemon loss cancels and settles profile writes"] = function () {
    let daemons = { [HADESS]: daemon() };
    let system = ownerBus(daemons);
    let finish = null;
    system.setProperty = function (name, path, property, value, cancellable, onDone) {
        finish = onDone;
    };
    let client = new Profiles.PowerProfilesClient(null, system);
    let outcome = null;
    client.setProfile("performance", error => { outcome = error; });
    let writeToken = system.cancellables[system.cancellables.length - 1];

    delete daemons[HADESS];
    system.watched.find(entry => entry.name === HADESS).vanished();
    Harness.equal(writeToken.cancelled, true, "the old owner's call is cancelled");
    Harness.ok(outcome && outcome.message, "the caller is told the daemon disappeared");

    let settled = outcome;
    finish(null);
    Harness.equal(outcome, settled, "the late cancellation reply cannot settle twice");
    client.destroy();
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

    delete daemons[UPOWER];
    system.watched.find(entry => entry.name === UPOWER).vanished();
    Harness.equal(client.available, false, "let go on the way out");
    Harness.equal(client.busName, null, "with no name left behind");
    Harness.equal(changes, 2, "and told again");
};

cases["a name appearance during discovery restarts a failed search"] = function () {
    let old = daemon();
    let oldAvailable = false;
    let newerReply = null;
    let system = bus({});
    system.proxy = function (backend, onDone) {
        if (backend.name === HADESS) {
            if (oldAvailable)
                onDone(old, null);
            else
                onDone(null, new Error("not owned yet"));
            return;
        }
        newerReply = onDone;
    };

    let client = new Profiles.PowerProfilesClient(null, system);
    Harness.ok(newerReply, "the alternate backend attempt is in flight");

    oldAvailable = true;
    system.watched.find(entry => entry.name === HADESS).appeared();
    Harness.equal(client.available, false, "the active search is allowed to settle first");

    newerReply(null, new Error("alternate is absent"));
    Harness.equal(client.busName, HADESS, "the remembered wake-up reruns preferred-first search");
    Harness.equal(client.available, true, "the daemon that appeared is adopted");
};

cases["a vanished backend falls through to an existing alternate"] = function () {
    let daemons = { [HADESS]: daemon(), [UPOWER]: daemon({ active: "performance" }) };
    let system = bus(daemons);
    let client = new Profiles.PowerProfilesClient(null, system);
    Harness.equal(client.busName, HADESS, "the preferred name is selected first");

    delete daemons[HADESS];
    system.watched.find(entry => entry.name === HADESS).vanished();
    Harness.equal(client.busName, UPOWER, "the already-owned alternate is selected");
    Harness.equal(client.active, "performance", "and supplies the live reading");
};

cases["a proxy without a property handler disconnects cleanly"] = function () {
    let stub = daemon();
    stub.connect = function () { return 0; };
    stub.disconnected = [];
    stub.disconnect = id => stub.disconnected.push(id);
    let daemons = { [HADESS]: stub };
    let system = ownerBus(daemons);
    let timers = retryTimers(system);
    let client = new Profiles.PowerProfilesClient(null, system);

    Harness.equal(client.available, false, "an unwired proxy is never published");
    Harness.equal(Object.keys(timers.pending).length, 1,
                  "the still-owned backend is retried after wiring failure");

    delete daemons[HADESS];
    system.watched.find(entry => entry.name === HADESS).vanished();
    Harness.deepEqual(stub.disconnected, [], "zero is no signal registration to release");
    client.destroy();
};

cases["the daemon's version is the daemon's, and there is none without one"] = function () {
    /*
     * The two bus names are the version the applet has to know about, and this
     * is the version the daemon says it is. It is read straight off the proxy,
     * so the only thing that can go wrong with it is being read off no proxy
     * at all - which is every machine with no daemon, and is a throw rather
     * than an answer if the guard goes.
     */
    let client = new Profiles.PowerProfilesClient(null, bus({ [UPOWER]: daemon({ version: "0.20" }) }));
    Harness.equal(client.version, "0.20", "what the daemon says it is");

    let none = new Profiles.PowerProfilesClient(null, bus({}));
    Harness.equal(none.available, false, "no daemon here");
    Harness.equal(none.version, null, "and so no version, rather than a throw");
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

/* ---------------------------------------------------------------- */
/* what a daemon says, when it is not what a daemon says             */

/*
 * Every property here arrives as a variant out of a proxy, and the daemon on
 * the other end is one of two implementations across half a dozen versions.
 * The list of profiles is an array of dictionaries of variants, and each of
 * those three levels is somewhere an unpack can go wrong - which reads as an
 * empty profile list and no explanation.
 *
 * So the shape is held rather than the values: names that are strings, a
 * reading that has every field the menu reads off it, and nothing that throws
 * at a caller which is a menu being drawn.
 */
function fuzzDaemon(random) {
    /*
     * The types are the ones the interface declares - a property the daemon
     * publishes as a string arrives as one - so what is varied is what the
     * dictionaries inside them carry. That is where the two implementations
     * and the versions between them really differ, and it is three levels
     * deep: an array, of dictionaries, of variants.
     */
    let profiles = [];
    let count = random.below(5);
    for (let i = 0; i < count; i++) {
        switch (random.below(4)) {
            case 0: profiles.push({ Profile: variant(Fuzz.text(random, 2)) }); break;
            case 1: profiles.push({ Profile: variant("") }); break;
            case 2: profiles.push({ Nothing: variant("balanced") }); break;
            default: profiles.push({ Profile: random.pick(PROFILE_NAMES) });
        }
    }

    let holds = [];
    let held = random.below(3);
    for (let i = 0; i < held; i++)
        holds.push(random.chance(3) ? {}
                                    : { ApplicationId: variant(Fuzz.text(random, 2)),
                                        Profile: variant(Fuzz.text(random, 1)) });

    let stub = {
        ActiveProfileHolds: holds,
        Profiles: profiles,
        connect: () => 1,
        disconnect: () => {},
    };
    if (!random.chance(3))
        stub.ActiveProfile = random.chance(2) ? Fuzz.text(random, 2) : "balanced";
    if (!random.chance(3))
        stub.PerformanceDegraded = Fuzz.text(random, 2);
    if (!random.chance(3))
        stub.PerformanceInhibited = Fuzz.text(random, 2);
    if (!random.chance(3))
        stub.Version = Fuzz.text(random, 1);
    return stub;
}

const PROFILE_NAMES = ["power-saver", "balanced", "performance"];

cases["whatever the daemon answers with reads as a menu can draw it"] = function () {
    Fuzz.forAll({ what: "a whole reading", runs: 400 }, fuzzDaemon, function (stub) {
        let client = new Profiles.PowerProfilesClient(null, bus({ [UPOWER]: stub }));
        let reading = Fuzz.answers(() => client.snapshot());

        /* A daemon offering nothing this applet can name is not one it can
         * use, and is passed over the way an unowned name is. */
        Harness.ok(Array.isArray(reading.profiles), "the profiles are a list");
        Harness.equal(reading.available, reading.profiles.length > 0,
                      "available exactly where there is something to pick");
        for (let name of reading.profiles)
            Fuzz.isString(name, "a profile name");
        Harness.ok(reading.active === null || typeof reading.active === "string",
                   "the active profile is a name or nothing: " + Fuzz.show(reading.active));
        Fuzz.isString(reading.degraded, "the degraded reason");
        Harness.ok(Array.isArray(reading.holds), "the holds are a list");
        for (let hold of reading.holds) {
            Fuzz.isString(hold.application, "the application holding it");
            Fuzz.isString(hold.profile, "the profile it is holding");
        }
        client.destroy();
    });
};

/* ------------------------------------------------------------------ */
/* stepping                                                            */

/* Every list this applet can be handed, in the order the backend gives it:
 * the daemon's own three, and what the kernel prints for a firmware that
 * offers three, four or two profiles. */
const DAEMON = ["power-saver", "balanced", "performance"];
const THINKPAD = ["low-power", "balanced", "performance"];
const QUIET_FIRST = ["quiet", "balanced", "balanced-performance", "performance"];

cases["stepping follows the order the backend published"] = function () {
    /*
     * Both backends list their profiles from the least performant to the
     * most - the daemon says so on its interface, and platform_profile_choices
     * is printed from the kernel's own enum, which runs low-power, cool,
     * quiet, balanced, balanced-performance, performance. So the backend has
     * already answered the only question stepping asks, which is which way is
     * up.
     */
    Harness.deepEqual(Profiles.orderedProfiles(THINKPAD), THINKPAD, "as the firmware said it");
    Harness.deepEqual(Profiles.orderedProfiles(DAEMON), DAEMON, "and as the daemon said it");
};

cases["a name with nothing in it is not a stop on the way"] = function () {
    Harness.deepEqual(Profiles.orderedProfiles(["balanced", "", "performance"]),
                      ["balanced", "performance"], "an empty name is not a profile");
    Harness.deepEqual(Profiles.orderedProfiles(null), [], "and no list is no profiles");
};

cases["the wheel steps up towards performance on firmware too"] = function () {
    /*
     * This is what the ordering was wrong about. Three known names were put
     * first and everything else appended, which on power-profiles-daemon is
     * exactly what it publishes and changes nothing - and on a ThinkPad, whose
     * lowest profile is called low-power, put that profile last. Scrolling up
     * from balanced reached performance and then the machine's *lowest*
     * setting, and scrolling down from balanced was clamped, so the low one
     * could only be got at by going up twice.
     */
    Harness.equal(Profiles.nextProfile(THINKPAD, "balanced", 1, false), "performance", "up");
    Harness.equal(Profiles.nextProfile(THINKPAD, "balanced", -1, false), "low-power", "and down");
    Harness.equal(Profiles.nextProfile(THINKPAD, "performance", 1, false), null,
                  "and the top of the travel is the top");
    Harness.equal(Profiles.nextProfile(THINKPAD, "low-power", -1, false), null,
                  "as is the bottom");
};

cases["what the wheel steps is what the buttons draw"] = function () {
    /*
     * The segmented control draws the backend's list as it stands, and it sits
     * two inches from the pointer that is turning the wheel. One control with
     * two orders in it is the whole of what was wrong here, so the property is
     * stated rather than the three examples: stepping up from any profile
     * lands on the one drawn to its right.
     */
    for (let list of [DAEMON, THINKPAD, QUIET_FIRST]) {
        for (let i = 0; i < list.length - 1; i++) {
            Harness.equal(Profiles.nextProfile(list, list[i], 1, false), list[i + 1],
                          list[i] + " steps up to the one beside it in " + list.join(", "));
            Harness.equal(Profiles.nextProfile(list, list[i + 1], -1, false), list[i],
                          "and back down to it again");
        }
    }
};

cases["a gathered flick moves by as many notches as it counted"] = function () {
    /* The wheel gathers a flick into one write rather than sending a step per
     * click, so what arrives here is a count. */
    Harness.equal(Profiles.nextProfile(QUIET_FIRST, "quiet", 3, false), "performance",
                  "three notches");
    Harness.equal(Profiles.nextProfile(QUIET_FIRST, "quiet", 9, false), "performance",
                  "and past the end is the end, not nothing");
    Harness.equal(Profiles.nextProfile(QUIET_FIRST, "performance", -9, false), "quiet",
                  "the same the other way");
};

cases["the hotkey comes round again where the wheel stops"] = function () {
    /* One key that cycles has to wrap, or it does nothing at all once it has
     * reached the end. */
    Harness.equal(Profiles.nextProfile(THINKPAD, "performance", 1, true), "low-power",
                  "round to the bottom");
    Harness.equal(Profiles.nextProfile(THINKPAD, "low-power", -1, true), "performance",
                  "and round the other way");
    Harness.equal(Profiles.nextProfile(THINKPAD, "balanced", 4, true), "performance",
                  "and a step longer than the list still lands on the list");
};

cases["a step that lands where it started is not a change"] = function () {
    /*
     * The caller writes a profile only where there is one to write: asking for
     * the profile already in force, or already in flight, is a duplicate that
     * the pending profile would drop anyway - and the hotkey announces
     * whatever it was told was taken.
     */
    Harness.equal(Profiles.nextProfile(DAEMON, "balanced", 0, false), null, "no notches");
    Harness.equal(Profiles.nextProfile(["balanced"], "balanced", 1, true), null,
                  "and a machine with one profile has nowhere to go");
};

cases["a machine with no profiles has nothing to step to"] = function () {
    Harness.equal(Profiles.nextProfile([], "balanced", 1, false), null, "no list");
    Harness.equal(Profiles.nextProfile(["", ""], "balanced", 1, true), null,
                  "and nothing usable in one");
};

cases["a profile that is not on the list starts from the beginning"] = function () {
    /* The daemon can change what it offers while a change is pending, and a
     * step from a name that is no longer there has to land somewhere. */
    Harness.equal(Profiles.nextProfile(THINKPAD, "vendor-turbo", 1, false), "low-power",
                  "the first entry is not skipped");
    Harness.equal(Profiles.nextProfile(THINKPAD, null, 1, false), "low-power",
                  "and so does a machine that has not said yet");
    Harness.equal(Profiles.nextProfile(THINKPAD, "vendor-turbo", -1, true), "low-power",
                  "the fallback is independent of step direction and wrapping");
};
