/*
 * The screen and keyboard backlights, against a stubbed settings daemon.
 *
 * The proxy is a parameter now, so these run with no session bus and no
 * csd-power. Before that the only thing exercising this module was the case
 * that loads it, which is to say nothing: a renamed method, a percentage read
 * out of the wrong place in the reply, a signal never connected - none of it
 * would have failed anywhere.
 *
 * The stub answers the way the daemon does: every remote call hands back an
 * array, because that is what a D-Bus reply unpacks to even when it carries
 * one value, and that array is exactly where two of these bugs would live.
 */

const Gio = imports.gi.Gio;

const Harness = imports.harness;

const Backlight = Harness.requireXlet("./lib/backlight.js");
const Log = Harness.requireXlet("./lib/log.js");

/*
 * A settings daemon proxy. `answers` says what each call returns; a value of
 * null makes that call fail, which is how a machine with the interface and no
 * backlight behind it answers.
 */
function proxy(answers, options) {
    let settings = options || {};
    let calls = [];
    let handlers = {};
    let pending = [];

    function answer(name, args, onDone) {
        let value = answers[name];
        if (typeof value === "function")
            value = value.apply(null, args);
        /* A call that answers with neither a reply nor a reason, which is
         * what a method whose reply carries nothing looks like from
         * here - and what a daemon that has been restarted under the
         * proxy can answer with. */
        if (settings.silent && settings.silent.indexOf(name) >= 0)
            onDone(null, null);
        else if (value === null || value === undefined)
            onDone(null, new Error(name + " is not available"));
        else
            onDone([value], null);
    }

    function remote(name) {
        return function () {
            let args = Array.prototype.slice.call(arguments);
            let onDone = args.pop();
            calls.push([name].concat(args));
            if (settings.deferred && settings.deferred.indexOf(name) >= 0)
                pending.push(() => answer(name, args, onDone));
            else
                answer(name, args, onDone);
        };
    }

    let stub = {
        calls: calls,
        handlers: handlers,
        pending: pending,
        GetPercentageRemote: remote("GetPercentage"),
        SetPercentageRemote: remote("SetPercentage"),
        StepUpRemote: remote("StepUp"),
        StepDownRemote: remote("StepDown"),
        connectSignal: function (name, handler) {
            handlers[name] = handler;
            return 7;
        },
        disconnectSignal: function (id) {
            calls.push(["disconnectSignal", id]);
        },
    };
    if (settings.toggle !== false)
        stub.ToggleRemote = remote("Toggle");
    return stub;
}

/* A control wired to a stub, with the answer already in hand: the stubbed
 * connect calls back before it returns, so nothing here waits. */
function control(kind, stub, error) {
    let ready = 0;
    let changed = 0;
    let backlight = new Backlight.BacklightControl(
        kind, () => changed++, () => ready++,
        (xml, onDone) => onDone(error ? null : stub, error || null));
    backlight.readyCount = () => ready;
    backlight.changedCount = () => changed;
    return backlight;
}

function ownerWatcher() {
    let owner = {
        reportsInitialState: true,
        unwatched: [],
        watch: function (appeared, vanished) {
            owner.appeared = appeared;
            owner.vanished = vanished;
            appeared();
            return 19;
        },
        unwatch: function (id) {
            owner.unwatched.push(id);
        },
    };
    return owner;
}

function retryTimers(owner) {
    let timers = { next: 1, pending: {}, delays: [], removed: [] };
    owner.timeoutAdd = function (delay, callback) {
        let id = timers.next++;
        timers.pending[id] = callback;
        timers.delays.push(delay);
        return id;
    };
    owner.removeTimer = function (id) {
        timers.removed.push(id);
        delete timers.pending[id];
    };
    timers.fire = function () {
        let ids = Object.keys(timers.pending);
        Harness.equal(ids.length, 1, "exactly one backlight retry is pending");
        let id = Number(ids[0]);
        let callback = timers.pending[id];
        delete timers.pending[id];
        callback();
    };
    return timers;
}

var cases = {};

cases["the production ownership adapter preserves both callbacks"] = function () {
    let watched = null;
    let removed = [];
    let bus = {
        bus_watch_name: function (type, name, flags, appeared, vanished) {
            watched = { type: type, name: name, flags: flags,
                        appeared: appeared, vanished: vanished };
            return 73;
        },
        bus_unwatch_name: id => removed.push(id),
    };
    let events = [];
    let id = Backlight.watchOwner(() => events.push("appeared"),
                                  () => events.push("vanished"), bus);

    Harness.equal(id, 73, "the watch token is passed through");
    Harness.equal(watched.name, Backlight.BUS_NAME, "the settings daemon is watched");
    watched.appeared();
    watched.vanished();
    Harness.deepEqual(events, ["appeared", "vanished"], "both owner edges survive the adapter");
    Backlight.unwatchOwner(id, bus);
    Harness.deepEqual(removed, [73], "the same token is released");
};

cases["an injected owner can use the production release fallback"] = function () {
    let owner = {
        reportsInitialState: false,
        watch: (appeared, vanished) => Backlight.watchOwner(appeared, vanished),
    };
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null,
        (xml, onDone) => onDone(proxy({ GetPercentage: 42 }), null), owner);

    Harness.equal(screen.percentage, 42, "the injected connector remains usable");
    screen.destroy();
    Harness.equal(screen.destroyed, true, "the production unwatch fallback completes teardown");
};

cases["monitor brightness follows the visible display topology"] = function () {
    Harness.equal(Backlight.shouldUseMonitorBacklight(false, false, false), false,
                  "the setting keeps every DDC probe off");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, false, false), true,
                  "a desktop with no kernel backlight needs DDC");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, true, false), false,
                  "an open laptop keeps using its built-in panel");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, true, true), true,
                  "a closed laptop gives its external monitors the controls");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, "unknown", false), false,
                  "unknown kernel state does not authorize an I2C probe");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, "unknown", true), true,
                  "explicit closed-lid topology authorizes the visible external screen");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, "degraded", false), false,
                  "a failed discovery does not masquerade as absent hardware");
    Harness.equal(Backlight.shouldUseMonitorBacklight(true, "absent", false), true,
                  "confirmed absence authorizes an external monitor probe");
};

cases["the brightness wheel follows the visible screen"] = function () {
    let screen = { available: true };
    let monitor = { available: true };
    Harness.equal(Backlight.visibleBacklightControl(screen, monitor, false), screen,
                  "an open laptop uses its panel");
    Harness.equal(Backlight.visibleBacklightControl(screen, monitor, true), monitor,
                  "a closed laptop uses its external monitor");
    monitor.available = false;
    Harness.equal(Backlight.visibleBacklightControl(screen, monitor, true), null,
                  "a closed panel is not changed when DDC has no answer");
    screen.available = false;
    monitor.available = true;
    Harness.equal(Backlight.visibleBacklightControl(screen, monitor, false), monitor,
                  "a desktop uses its external monitor");
    monitor.available = false;
    Harness.equal(Backlight.visibleBacklightControl(screen, monitor, false), null,
                  "no available screen means no control");
};

cases["a backlight answers with what the daemon reports"] = function () {
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 42 }));
    Harness.equal(screen.available, true, "the daemon answered, so there is one");
    Harness.equal(screen.percentage, 42, "and this is where it is");
    Harness.equal(screen.readyCount(), 1, "ready is said once, when the answer is in");
    Harness.equal(screen._valueGeneration, 1,
                  "the first read advances once from the initial generation");
};

cases["the owner watch performs the only production startup read"] = function () {
    let stub = proxy({ GetPercentage: 42 });
    let owner = ownerWatcher();
    let connections = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null,
        (xml, onDone) => { connections++; onDone(stub, null); }, owner);

    Harness.equal(connections, 1, "the proxy is initialized once");
    Harness.deepEqual(stub.calls.filter(call => call[0] === "GetPercentage"),
                      [["GetPercentage"]], "with one startup percentage read");
    screen.destroy();
    Harness.deepEqual(owner.unwatched, [19], "the injected owner watch is released");
};

cases["a failed backlight owner watch is restored"] = function () {
    let stub = proxy({ GetPercentage: 42 });
    let owner = ownerWatcher();
    let timers = retryTimers(owner);
    let install = owner.watch;
    let attempts = 0;
    owner.watch = function (appeared, vanished) {
        attempts++;
        if (attempts === 1)
            throw new Error("session bus unavailable");
        return install(appeared, vanished);
    };
    let lines = [];
    let screen;
    Log.setSink(line => lines.push(line));
    try {
        screen = new Backlight.BacklightControl(
            Backlight.SCREEN, null, null,
            (xml, onDone) => onDone(stub, null), owner);
        Harness.equal(screen.available, true, "direct discovery preserves the current value");
        timers.fire();
        Harness.equal(attempts, 2, "the missing owner edge is installed later");
        Harness.equal(lines.length, 1, "the registration incident is logged once");
    } finally {
        Log.setSink(null);
        if (screen)
            screen.destroy();
    }
    Harness.deepEqual(owner.unwatched, [19], "the recovered watch is released");
};

cases["teardown cancels an in-flight proxy initialization"] = function () {
    let owner = ownerWatcher();
    let pending = null;
    let token = null;
    let ready = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, () => ready++,
        (xml, onDone, cancellable) => {
            pending = onDone;
            token = cancellable;
        }, owner);

    Harness.ok(token, "proxy initialization owns a cancellable");
    screen.destroy();
    Harness.equal(token.is_cancelled(), true, "the obsolete bus work is stopped");
    pending(proxy({ GetPercentage: 70 }), null);
    Harness.equal(screen.available, false, "its late answer is ignored");
    Harness.equal(ready, 0, "and cannot call into the removed applet");
};

cases["owner replacement cancels the old backlight proxy initialization"] = function () {
    let owner = ownerWatcher();
    let pending = [];
    let tokens = [];
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null,
        (xml, onDone, cancellable) => {
            pending.push(onDone);
            tokens.push(cancellable);
        }, owner);

    owner.vanished();
    Harness.equal(tokens[0].is_cancelled(), true, "owner loss stops the old proxy request");
    owner.appeared();
    Harness.equal(tokens.length, 2, "the replacement owner gets a fresh request");
    pending[0](proxy({ GetPercentage: 10 }), null);
    Harness.equal(screen.available, false, "the old owner's late proxy is ignored");
    pending[1](proxy({ GetPercentage: 65 }), null);
    Harness.equal(screen.percentage, 65, "the replacement proxy supplies the value");
    screen.destroy();
};

cases["an interface with no backlight behind it is not available"] = function () {
    /* csd exports Power.Screen on a desktop too, and answers it with an
     * error. That error is the answer to "is there one", not a failure. */
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: null }));
    Harness.equal(screen.available, false, "nothing behind it");
    Harness.equal(screen.percentage, null, "so no value to show");
    Harness.equal(screen.readyCount(), 1, "and the caller is told, or it waits for ever");
    Harness.equal(screen.hardwareState, "absent", "the wired daemon confirmed no hardware");
};

cases["a daemon that will not connect is not available"] = function () {
    let screen = control(Backlight.SCREEN, null, new Error("no such name"));
    Harness.equal(screen.available, false, "no proxy");
    Harness.equal(screen.readyCount(), 1, "still answered");
    Harness.equal(screen.hardwareState, "degraded", "connection failure is not hardware absence");
};

cases["owned degraded backlight discovery retries until recovery"] = function () {
    let owner = ownerWatcher();
    let timers = retryTimers(owner);
    let attempts = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            onDone(attempts < 3 ? null : proxy({ GetPercentage: 63 }),
                   attempts < 3 ? new Error("proxy unavailable") : null);
        }, owner);

    Harness.equal(screen.hardwareState, "degraded", "the failed startup remains unknown");
    Harness.deepEqual(timers.delays, [Backlight.RETRY_INITIAL_MS], "retry starts at its floor");
    timers.fire();
    Harness.equal(screen.hardwareState, "degraded", "another connection failure stays degraded");
    Harness.deepEqual(timers.delays, [500, 1000], "retry backs off while ownership persists");
    timers.fire();
    Harness.equal(screen.hardwareState, "present", "a confirmed percentage recovers discovery");
    Harness.equal(screen.percentage, 63, "the recovered value is published");
    Harness.equal(Object.keys(timers.pending).length, 0, "success leaves no retry armed");
    screen.destroy();
};

cases["retry cancellation releases injected and fallback timers"] = function () {
    let owner = ownerWatcher();
    let timers = retryTimers(owner);
    let injected = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null,
        (xml, onDone) => onDone(null, new Error("proxy unavailable")), owner);
    Harness.equal(Object.keys(timers.pending).length, 1, "the owner timer is armed");

    owner.vanished();
    Harness.deepEqual(timers.removed, [1], "owner loss releases the injected timer");
    Harness.equal(injected._retryTimerId, 0, "and clears its token");
    Harness.equal(injected._retryDelay, Backlight.RETRY_INITIAL_MS,
                  "cancellation resets backoff for a future owner");
    injected.destroy();

    let fallbackOwner = ownerWatcher();
    let fallback = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null,
        (xml, onDone) => onDone(null, new Error("proxy unavailable")), fallbackOwner);
    Harness.ok(fallback._retryTimerId !== 0, "the GLib fallback timer is armed");
    fallback.destroy();
    Harness.equal(fallback._retryTimerId, 0, "teardown removes the GLib timer too");
};

cases["a failed connection is retried on refresh"] = function () {
    let attempts = 0;
    let recovered = proxy({ GetPercentage: 64 });
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            if (attempts === 1)
                onDone(null, new Error("daemon is starting"));
            else
                onDone(recovered, null);
        });

    Harness.equal(screen.available, false, "the first attempt failed");
    screen.refresh();
    Harness.equal(attempts, 2, "refresh reconnects rather than keeping no proxy forever");
    Harness.equal(screen.available, true, "and adopts the recovered backend");
    Harness.equal(screen.percentage, 64, "with its current value");
};

cases["a backlight proxy is published only after its signal is wired"] = function () {
    let broken = proxy({ GetPercentage: 20 });
    broken.connectSignal = function () { throw new Error("Changed subscription failed"); };
    let recovered = proxy({ GetPercentage: 64 });
    let attempts = 0;
    let ready = 0;
    let lines = [];
    Log.setSink(line => lines.push(line));
    let screen;
    try {
        screen = new Backlight.BacklightControl(
            Backlight.SCREEN, null, () => ready++,
            (xml, onDone) => onDone(attempts++ < 2 ? broken : recovered, null));
        Harness.equal(screen._proxy, null, "the unwired proxy is not visible");
        Harness.equal(screen.available, false, "nor is it treated as a backlight");
        Harness.equal(ready, 1, "the failed setup still settles readiness");
        Harness.ok(lines.join("").indexOf("Changed subscription failed") >= 0,
                   "the wiring failure is diagnosed");

        screen.refresh();
        Harness.equal(attempts, 2, "the next refresh retries the broken wiring");
        Harness.equal(lines.length, 1, "the continuous wiring failure is logged once");
        screen.refresh();
        Harness.equal(attempts, 3, "a later refresh rebuilds the proxy again");
        Harness.equal(screen.percentage, 64, "the fully wired replacement is published");
    } finally {
        if (screen)
            screen.destroy();
        Log.setSink(null);
    }
};

cases["overlapping refreshes share one proxy initialization"] = function () {
    let finish = null;
    let attempts = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            finish = onDone;
        });
    let answered = 0;
    screen.refresh(() => answered++);
    screen.refresh(() => answered++);

    Harness.equal(attempts, 1, "one connection attempt is in flight");
    finish(proxy({ GetPercentage: 51 }), null);
    Harness.equal(screen.percentage, 51, "the shared proxy supplies the value");
    Harness.equal(answered, 2, "both overlapping callers settle");
    screen.destroy();
};

cases["a synchronous percentage-call failure settles the read"] = function () {
    let stub = proxy({ GetPercentage: 50 });
    let screen = control(Backlight.SCREEN, stub);
    stub.GetPercentageRemote = function () { throw new Error("call setup failed"); };
    let answered = 0;

    screen.refresh(() => answered++);
    Harness.equal(answered, 1, "the caller is answered");
    Harness.equal(screen.available, false, "the failed proxy is dropped");
    Harness.equal(screen.percentage, null, "and no stale value is retained");
    screen.destroy();
};

cases["a read rejected before it starts settles every waiter"] = function () {
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 50 }));
    screen.destroy();
    let answered = 0;
    screen._startRead([() => answered++, () => answered++]);
    Harness.equal(answered, 2, "every accepted waiter is released");
    screen._onOwnerAppeared();
    Harness.equal(answered, 2, "a destroyed owner callback does nothing");
};

cases["a failed first read rebuilds the proxy"] = function () {
    let attempts = 0;
    let first = proxy({ GetPercentage: null });
    let recovered = proxy({ GetPercentage: 58 });
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            onDone(attempts === 1 ? first : recovered, null);
        });

    Harness.equal(screen.available, false, "the interface did not answer at startup");
    screen.refresh();
    Harness.equal(attempts, 2, "the stale proxy was replaced");
    Harness.equal(screen.available, true, "a later successful read promotes it");
    Harness.equal(screen.percentage, 58, "from the replacement proxy");
};

cases["a known backlight automatically reconnects after a read failure"] = function () {
    let owner = ownerWatcher();
    let timers = retryTimers(owner);
    let readings = [40, null];
    let first = proxy({ GetPercentage: () => readings.shift() });
    let recovered = proxy({ GetPercentage: 58 });
    let attempts = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            onDone(attempts === 1 ? first : recovered, null);
        }, owner);

    Harness.equal(screen.hardwareState, "present", "the initial value confirms hardware");
    screen.refresh();
    Harness.equal(screen.available, false, "the failed live read lowers availability");
    Harness.equal(screen.hardwareState, "present", "known hardware is not reclassified absent");
    Harness.equal(Object.keys(timers.pending).length, 1, "the reconnect is scheduled");
    timers.fire();
    Harness.equal(attempts, 2, "the retry builds a fresh proxy");
    Harness.equal(screen.available, true, "the replacement proxy restores availability");
    Harness.equal(screen.percentage, 58, "and publishes its current value");
    Harness.equal(Object.keys(timers.pending).length, 0, "recovery leaves no timer");
    screen.destroy();
};

cases["an unsupported backlight does not retry its first read"] = function () {
    let owner = ownerWatcher();
    let timers = retryTimers(owner);
    let attempts = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            onDone(proxy({ GetPercentage: null }), null);
        }, owner);

    Harness.equal(screen.hardwareState, "absent", "the first reply confirms no hardware");
    Harness.equal(Object.keys(timers.pending).length, 0, "unsupported hardware has no retry");
    Harness.equal(attempts, 1, "the initial decision is not probed repeatedly");
    screen.destroy();
};

cases["a kind this module does not know is ready at once"] = function () {
    let odd = control("fingerprint-reader", proxy({ GetPercentage: 50 }));
    Harness.equal(odd.available, false, "there is no interface for it");
    Harness.equal(odd.readyCount(), 1, "and the caller is not left waiting on one");
};

cases["the control hands itself to whoever is waiting for the answer"] = function () {
    /*
     * Every one of the three ways this can be ready is reached from inside the
     * constructor, so `new BacklightControl(...)` has not returned and nothing
     * the caller assigned it to exists yet. The applet's own onReady asks
     * whether this machine has a kernel backlight, which decides whether it
     * goes anywhere near the I2C bus - and it used to ask the field it was
     * about to write, which on a bus that cannot be reached at all is a
     * TypeError in the applet's constructor and no applet on the panel.
     */
    let answered = [];
    let ready = kind => new Backlight.BacklightControl(
        kind, () => {}, control => answered.push(control),
        (xml, onDone) => onDone(null, new Error("no session bus here")));

    let screen = ready(Backlight.SCREEN);
    let odd = ready("fingerprint-reader");

    Harness.equal(answered.length, 2, "both were answered");
    Harness.equal(answered[0], screen, "the connection that failed handed over itself");
    Harness.equal(answered[1], odd, "and so did the kind with no interface");
    Harness.equal(answered[0].available, false,
                  "which is the whole of what the caller needed to ask it");
};

cases["a value is clamped and rounded before it is sent"] = function () {
    let stub = proxy({ GetPercentage: 40, SetPercentage: 45 });
    let screen = control(Backlight.SCREEN, stub);
    screen.setPercentage(44.6);
    screen.setPercentage(140);
    screen.setPercentage(-3);
    Harness.deepEqual(stub.calls.filter(call => call[0] === "SetPercentage"),
                      [["SetPercentage", 45], ["SetPercentage", 100], ["SetPercentage", 0]],
                      "the daemon takes a whole percentage in range");
};

cases["what the daemon set is what is kept, not what was asked for"] = function () {
    /* Some panels have far fewer steps than a hundred, so the daemon answers
     * with where the backlight actually ended up. */
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 40, SetPercentage: 33 }));
    let outcome = null;
    screen.setPercentage(37, value => { outcome = value; });
    Harness.equal(screen.percentage, 33, "the daemon's number, not the slider's");
    Harness.deepEqual(outcome, { ok: true, percentage: 33 },
                      "the caller receives the confirmed result");
};

cases["brightness mutation failures are reported and resampled consistently"] = function () {
    let reads = [40, 35, 30];
    let stub = proxy({
        GetPercentage: () => reads.shift(),
        SetPercentage: null,
        StepUp: null,
    });
    let screen = control(Backlight.SCREEN, stub);
    let keyboard = null;
    let outcomes = [];
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        screen.setPercentage(70, outcome => outcomes.push(outcome));
        Harness.equal(outcomes[0].ok, false, "a refused absolute write reports failure");
        Harness.ok(outcomes[0].error instanceof Error, "the D-Bus reason is retained");
        Harness.equal(screen.percentage, 35, "the failure is replaced by a fresh daemon read");

        screen.stepBy(1, outcome => outcomes.push(outcome));
        Harness.equal(outcomes[1].ok, false, "a refused step uses the same outcome");
        Harness.equal(screen.percentage, 30, "and the same resampling policy");
        Harness.equal(lines.length, 2, "each rejected action has one diagnostic");
        Harness.ok(lines[0].indexOf("set failed") >= 0, "the absolute action is named");
        Harness.ok(lines[1].indexOf("step failed") >= 0, "the relative action is named");

        let keyboardReads = [60, 50];
        keyboard = control(Backlight.KEYBOARD, proxy({
            GetPercentage: () => keyboardReads.shift(),
            Toggle: null,
        }));
        keyboard.toggle(outcome => outcomes.push(outcome));
        Harness.equal(outcomes[2].ok, false, "a refused toggle reports failure too");
        Harness.equal(keyboard.percentage, 50, "toggle failure resamples the keyboard");
        Harness.equal(lines.length, 3, "toggle refusal has the same one-line policy");
        Harness.ok(lines[2].indexOf("toggle failed") >= 0, "the toggle action is named");
    } finally {
        Log.setSink(null);
        screen.destroy();
        if (keyboard)
            keyboard.destroy();
    }
};

cases["slider writes serialize and keep only the latest waiting value"] = function () {
    let stub = proxy({
        GetPercentage: 40,
        SetPercentage: value => value,
    }, { deferred: ["SetPercentage"] });
    let screen = control(Backlight.SCREEN, stub);
    let answered = 0;

    screen.setPercentage(30, () => answered++);
    screen.setPercentage(60, () => answered++);
    screen.setPercentage(90, () => answered++);
    Harness.deepEqual(stub.calls.filter(call => call[0] === "SetPercentage"),
                      [["SetPercentage", 30]], "only one write is in flight");
    Harness.equal(answered, 1, "the superseded waiting value is answered immediately");

    stub.pending.shift()();
    Harness.deepEqual(stub.calls.filter(call => call[0] === "SetPercentage"),
                      [["SetPercentage", 30], ["SetPercentage", 90]],
                      "the drag's final value follows the first write");
    Harness.equal(answered, 2, "the first write answered once");

    stub.pending.shift()();
    Harness.equal(answered, 3, "the final write answered once too");
    Harness.equal(screen.percentage, 90, "and the latest daemon result wins");
};

cases["proxy loss settles every queued mutation"] = function () {
    let stub = proxy({ GetPercentage: 40, SetPercentage: 30,
                       Toggle: 0, StepUp: 45 },
                     { deferred: ["SetPercentage", "Toggle", "StepUp"] });
    let screen = control(Backlight.KEYBOARD, stub);
    let answered = 0;

    screen.setPercentage(30, () => answered++);
    screen.toggle(() => answered++);
    screen.stepBy(2, () => answered++);
    Harness.equal(stub.pending.length, 1, "one mutation reached the old proxy");

    screen._onOwnerVanished();
    Harness.equal(answered, 3, "the in-flight and queued callers all settle");
    Harness.equal(screen.available, false, "the vanished backend is unavailable");

    stub.pending.shift()();
    Harness.equal(answered, 3, "a late reply cannot answer any caller twice");
    Harness.deepEqual(stub.calls.filter(call =>
        ["SetPercentage", "Toggle", "StepUp"].indexOf(call[0]) >= 0),
                      [["SetPercentage", 30]], "nothing queued reaches the stale proxy");
};

cases["proxy loss between notches stops the gathered flick"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 45 },
                     { deferred: ["StepUp"] });
    let screen = control(Backlight.SCREEN, stub);
    let answered = 0;

    screen.stepBy(3, () => answered++);
    Harness.equal(stub.pending.length, 1, "the first notch is in flight");
    screen._onOwnerVanished();
    Harness.equal(answered, 1, "owner loss settles the flick");

    stub.pending.shift()();
    Harness.deepEqual(stub.calls.filter(call => call[0] === "StepUp"),
                      [["StepUp"]], "the reply does not dereference the lost proxy again");
    Harness.equal(answered, 1, "and cannot settle the flick twice");
};

cases["a step is the daemon's own notch"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 50, StepDown: 30 });
    let screen = control(Backlight.SCREEN, stub);
    screen.step(true);
    Harness.equal(screen.percentage, 50, "up");
    screen.step(false);
    Harness.equal(screen.percentage, 30, "down");
    Harness.deepEqual(stub.calls.filter(call => call[0].indexOf("Step") === 0),
                      [["StepUp"], ["StepDown"]],
                      "no size is passed, because the size is the daemon's business");
};

cases["only the keyboard has a toggle"] = function () {
    let keyboard = control(Backlight.KEYBOARD, proxy({ GetPercentage: 60, Toggle: 0 }));
    keyboard.toggle();
    Harness.equal(keyboard.percentage, 0, "off, and it says where it went");

    let stub = proxy({ GetPercentage: 60 }, { toggle: false });
    let screen = control(Backlight.SCREEN, stub);
    screen.toggle();
    Harness.deepEqual(stub.calls.filter(call => call[0] === "Toggle"), [],
                      "the screen interface has no such call and must not be asked for it");
};

cases["something else moving the backlight is read and reported"] = function () {
    /* A function key, or the daemon dimming on idle. The value is re-read
     * rather than assumed, because the signal carries nothing. */
    let stub = proxy({ GetPercentage: 40 });
    let screen = control(Backlight.SCREEN, stub);
    Harness.equal(screen.changedCount(), 0, "nothing has happened yet");

    stub.calls.length = 0;
    stub.GetPercentageRemote = (onDone) => onDone([15], null);
    stub.handlers.Changed();

    Harness.equal(screen.percentage, 15, "read again rather than guessed");
    Harness.equal(screen.changedCount(), 1, "and passed on once");
};

cases["overlapping refreshes coalesce behind the newest read"] = function () {
    let answers = { GetPercentage: 40 };
    let stub = proxy(answers, { deferred: ["GetPercentage"] });
    let screen = control(Backlight.SCREEN, stub);
    stub.pending.shift()();
    stub.calls.length = 0;
    let answered = 0;

    screen.refresh(() => answered++);
    screen.refresh(() => answered++);
    Harness.equal(stub.pending.length, 1, "only one read is in flight");

    answers.GetPercentage = null;
    stub.pending.shift()();
    Harness.equal(stub.pending.length, 1, "a newer request becomes one follow-up read");
    Harness.equal(answered, 0, "both callers wait for the current snapshot");
    Harness.equal(screen.available, true, "a superseded failure keeps the live proxy");

    answers.GetPercentage = 72;
    stub.pending.shift()();
    Harness.equal(screen.percentage, 72, "the newest serialized read wins");
    Harness.equal(answered, 2, "every coalesced caller settles once");
};

cases["a mutation invalidates an older percentage read"] = function () {
    let answers = { GetPercentage: 40, SetPercentage: value => value };
    let stub = proxy(answers, { deferred: ["GetPercentage", "SetPercentage"] });
    let screen = control(Backlight.SCREEN, stub);
    stub.pending.shift()();

    screen.refresh();
    screen.setPercentage(80);
    let write = stub.pending.splice(1, 1)[0];
    write();
    Harness.equal(screen.percentage, 80, "the later mutation supplies the visible value");

    answers.GetPercentage = 20;
    stub.pending.shift()();
    Harness.equal(screen.percentage, 80, "the older read cannot overwrite the mutation");
};

cases["stale step replies cannot change the visible percentage"] = function () {
    function attempt(configure, answer, error) {
        let live = proxy({ GetPercentage: 40, StepUp: 90 });
        let screen = control(Backlight.SCREEN, live);
        let generation = screen._generation;
        let valueGeneration = screen._valueGeneration;
        let calls = 0;
        let reply = null;
        live.StepUpRemote = onDone => { calls++; reply = onDone; };

        let finished = 0;
        let count = (configure === "value" || configure === "empty") ? 1 : 3;
        screen._runSteps({ count: count, up: true }, live, generation,
                         valueGeneration, () => finished++);
        if (configure === "destroyed")
            screen.destroyed = true;
        else if (configure === "generation")
            screen._generation++;
        else if (configure === "proxy")
            screen._proxy = proxy({ GetPercentage: 10 });
        else if (configure === "value")
            screen._valueGeneration++;
        reply(answer, error || null);
        Harness.equal(screen.percentage, 40, configure + " reply is stale");
        Harness.equal(calls, 1, configure + " reaches one already-started call");
        Harness.equal(finished, 1, configure + " still settles");
        screen.destroyed = false;
        screen._proxy = live;
        screen.destroy();
    }

    attempt("destroyed", [90]);
    attempt("generation", [90]);
    attempt("proxy", [90]);
    attempt("value", [90]);
    attempt("error", [90], new Error("daemon refused the step"));
    attempt("empty", null);
};

cases["a failed step stops the rest of a gathered flick"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 90 });
    let screen = control(Backlight.SCREEN, stub);
    let calls = 0;
    stub.StepUpRemote = onDone => {
        calls++;
        onDone(null, new Error("step failed"));
    };

    screen.stepBy(3);
    Harness.equal(calls, 1, "an error terminates the sequence immediately");
    Harness.equal(screen.percentage, 40, "and does not invent a new value");
    screen.destroy();
};

cases["a mutation reply after teardown cannot change brightness"] = function () {
    let stub = proxy({ GetPercentage: 40, SetPercentage: value => value },
                     { deferred: ["SetPercentage"] });
    let screen = control(Backlight.SCREEN, stub);
    let answered = 0;
    screen.setPercentage(75, () => answered++);

    screen.destroyed = true;
    stub.pending.shift()();
    Harness.equal(screen.percentage, 40, "the removed applet keeps its last confirmed value");
    Harness.equal(answered, 1, "the operation still settles exactly once");
    screen.destroyed = false;
    screen.destroy();
};

cases["proxy loss settles every coalesced refresh waiter"] = function () {
    let stub = proxy({ GetPercentage: 40 }, { deferred: ["GetPercentage"] });
    let screen = control(Backlight.SCREEN, stub);
    stub.pending.shift()();
    let answered = 0;

    screen.refresh(() => answered++);
    screen.refresh(() => answered++);
    screen.refresh(() => answered++);
    screen.destroy();
    Harness.equal(answered, 3, "the active read and both queued callers are released");

    stub.pending.shift()();
    Harness.equal(answered, 3, "the late bus reply cannot answer any caller twice");
};

cases["a destroyed control lets go and stops answering"] = function () {
    let stub = proxy({ GetPercentage: 40 });
    let screen = control(Backlight.SCREEN, stub);
    screen.destroy();
    Harness.equal(screen.available, false, "not available once it is gone");
    Harness.deepEqual(stub.calls.filter(call => call[0] === "disconnectSignal"),
                      [["disconnectSignal", 7]], "the Changed handler goes with it");

    stub.calls.length = 0;
    screen.setPercentage(50);
    screen.step(true);
    Harness.deepEqual(stub.calls, [],
                      "and nothing reaches a daemon on behalf of an applet that has left");
};

cases["a destroyed control rejects refresh without reconnecting"] = function () {
    let attempts = 0;
    let screen = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => {
            attempts++;
            onDone(proxy({ GetPercentage: 40 }), null);
        });
    screen.destroy();
    let answered = 0;

    Harness.equal(screen.refresh(() => answered++), false,
                  "post-teardown refresh is rejected");
    Harness.equal(answered, 1, "the rejected caller is settled once");
    Harness.equal(attempts, 1, "no replacement proxy is constructed");
    screen._ensureProxy(() => answered++);
    Harness.equal(answered, 2, "the lower connection boundary also settles rejection");
    Harness.equal(attempts, 1, "the lower boundary cannot revive the control either");
};

cases["every call answers its caller, even where there is nothing to call"] = function () {
    /*
     * The contract this class shares with lib/ddc.js, which counts callbacks
     * down to know when a group of monitors has finished. A control that says
     * nothing when there is no proxy behind it is one a counting caller waits
     * on for ever.
     */
    let screen = control(Backlight.SCREEN, null, new Error("no such name"));
    let answered = 0;
    screen.refresh(() => answered++);
    screen.setPercentage(50, () => answered++);
    screen.toggle(() => answered++);
    screen.stepBy(2, () => answered++);
    Harness.equal(answered, 4, "no proxy is an answer, not a silence");
};

cases["a call in flight when the applet leaves still answers"] = function () {
    /* The other way out that said nothing: the applet is removed while the
     * daemon is thinking about it, and whoever asked is still counting.
     * Destroyed on the way out, as removing the applet mid-call would. */
    let stub = proxy({ GetPercentage: 40, SetPercentage: 70, Toggle: 0 });
    let screen = control(Backlight.KEYBOARD, stub);

    let answered = 0;
    for (let name of ["GetPercentageRemote", "SetPercentageRemote", "ToggleRemote"]) {
        let real = stub[name];
        stub[name] = function () {
            screen.destroyed = true;
            return real.apply(stub, arguments);
        };
    }

    screen.refresh(() => answered++);
    screen.setPercentage(70, () => answered++);
    screen.toggle(() => answered++);
    Harness.equal(answered, 3, "a reply for an applet that has gone is still a reply");
};

cases["a gathered flick is that many of the daemon's own notches"] = function () {
    /*
     * Not turned into a percentage: the notch is the daemon's to size and it
     * is the same one the brightness keys use, which is the whole reason this
     * goes through the daemon rather than writing sysfs.
     */
    let stub = proxy({ GetPercentage: 40, StepUp: 55, StepDown: 25 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;

    screen.stepBy(3);
    Harness.deepEqual(stub.calls, [["StepUp"], ["StepUp"], ["StepUp"]],
                      "three notches, one after another");
    Harness.equal(screen.percentage, 55, "and it ends where the daemon says it ended");

    stub.calls.length = 0;
    screen.stepBy(-2);
    Harness.deepEqual(stub.calls, [["StepDown"], ["StepDown"]], "and down the same way");
};

cases["a flick that gathered to nothing does nothing"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 45 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;
    screen.stepBy(0);
    Harness.deepEqual(stub.calls, [], "up and back down again is where it started");
};

cases["a destroyed control stops part way through a flick"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 45 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;

    /* Destroy on the first answer, as removing the applet mid-flick would. */
    let real = stub.StepUpRemote;
    stub.StepUpRemote = onDone => { screen.destroy(); real(onDone); };
    screen.stepBy(5);
    Harness.deepEqual(stub.calls.filter(call => call[0] === "StepUp"), [["StepUp"]],
                      "the notch that was already out, and none of the four behind it");
};

/* ---------------------------------------------------------------- */
/* answers that are neither a reply nor a reason                    */

cases["a connect that hands over nothing at all is no backlight"] = function () {
    /*
     * The guard reads "an error or no proxy", and both halves of that are
     * needed: makeProxyWrapper answers with an error, and a connect that
     * simply hands over nothing - which is what the stubbed one does when
     * there is nothing to hand over - answers with neither. Taking the second
     * as a working proxy means connecting a signal to null, in a constructor.
     */
    let backlight = new Backlight.BacklightControl(
        Backlight.SCREEN, null, null, (xml, onDone) => onDone(null, null));

    Harness.equal(backlight.available, false, "no proxy is no backlight");
    Harness.equal(backlight.percentage, null, "and nothing to report");
};

cases["a read that answers with nothing is no backlight either"] = function () {
    /*
     * The interface is exported on machines that have no panel backlight
     * behind it, so the first read is what really decides whether there is
     * one. It is guarded on "an error or no result", and a reply carrying
     * nothing is the second: reading a percentage out of it is reading index
     * nought of nothing.
     */
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 42 }, { silent: ["GetPercentage"] }));
    Harness.equal(screen.available, false, "nothing answered, so nothing is claimed");
    Harness.equal(screen.percentage, null, "and no percentage was read out of it");
    Harness.equal(screen.readyCount(), 1, "the caller is still told the answer is in");
};

cases["a write that answers with nothing leaves the value alone"] = function () {
    /*
     * The daemon answers with what it actually set, which is not always what
     * was asked for, so the reply is where the percentage comes from. A reply
     * that carries nothing is not a new value - and reading one out of it is
     * a percentage of undefined on a slider.
     */
    let stub = proxy({ GetPercentage: 40, SetPercentage: 55, StepUp: 45, StepDown: 35 },
                     { silent: ["SetPercentage", "StepUp", "StepDown"] });
    let screen = control(Backlight.SCREEN, stub);
    Harness.equal(screen.percentage, 40, "where it started");

    screen.setPercentage(70);
    Harness.equal(screen.percentage, 40, "the write went out and said nothing back");

    screen.stepBy(1);
    Harness.equal(screen.percentage, 40, "and a notch that answers with nothing moves nothing");

    screen.step(false);
    Harness.equal(screen.percentage, 40, "the same the other way, which is its own call");

    Harness.deepEqual(stub.calls.map(call => call[0]),
                      ["GetPercentage", "SetPercentage", "GetPercentage",
                       "StepUp", "GetPercentage", "StepDown", "GetPercentage"],
                      "every failed mutation is followed by a real-state read");

    /* The keyboard's toggle is a fourth call with the same guard on its
     * reply, and the only one of them the screen does not have. */
    let keyboard = control(Backlight.KEYBOARD,
                           proxy({ GetPercentage: 40, Toggle: 0 }, { silent: ["Toggle"] }));
    keyboard.toggle();
    Harness.equal(keyboard.percentage, 40, "a toggle that answers with nothing moves nothing");
};

/* ---------------------------------------------------------------- */
/* the reach for the bus itself                                     */

cases["an interface nobody can parse is no backlight, not a throw"] = function () {
    /*
     * Every case above hands in a proxy of its own, so the one way this module
     * really reaches the bus was exercised by none of them. Building a proxy
     * wrapper parses the interface, and that parse throws where the XML is not
     * an interface - which would come up through the applet's constructor,
     * since that is where a backlight is first asked for.
     *
     * A failure to build is reported the way a failure to connect is, because
     * to everything above they mean the same thing: no backlight here.
     */
    let answers = [];
    Backlight.connectProxy("<node><interface", (proxy, error) => answers.push([proxy, error]));

    Harness.equal(answers.length, 1, "answered rather than thrown");
    Harness.equal(answers[0][0], null, "with no proxy");
    Harness.ok(answers[0][1], "and something to say about why: " + answers[0][1]);
};

cases["the interfaces this module declares are ones a proxy can be built for"] = function () {
    /*
     * The other half, against a real session bus: both of the XML strings this
     * module carries, put through the parser the applet puts them through. A
     * mistyped signature or an unclosed tag is a backlight that quietly never
     * appears, and nothing else here would have said so.
     *
     * csd-power does not have to be running - and on the machine this was
     * written on it is not. A proxy for a name nobody owns is still a proxy;
     * what it has no owner for is only found out when something is called on
     * it, which is what the cases above cover.
     */
    try {
        Gio.bus_get_sync(Gio.BusType.SESSION, null);
    } catch (error) {
        Harness.skip("no session bus here");
    }

    for (let kind of [Backlight.SCREEN, Backlight.KEYBOARD]) {
        let built = Harness.settle(done => Backlight.connectProxy(
            Backlight.INTERFACES[kind], (proxy, error) => done({ proxy: proxy, error: error })),
            "a proxy for the " + kind);
        Harness.ok(!built.error, "the " + kind + " interface parsed: " + built.error);
        Harness.ok(built.proxy, "and a proxy for it was built");
    }
};
