/*
 * cinnamon-powertoys - screen and keyboard backlight.
 *
 * cinnamon-settings-daemon owns both, on one object carrying one interface
 * each. The interfaces are exported whether or not the machine has the
 * backlight behind them - a desktop with no panel backlight still answers
 * org.cinnamon.SettingsDaemon.Power.Screen, with an error - so whether there
 * is one to control is only known once the daemon has been asked. That is why
 * available starts false and why the caller is told when the answer is in.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Log = require("./lib/log.js");
const OwnerWatch = require("./lib/owner-watch.js");

var BUS_NAME = "org.cinnamon.SettingsDaemon.Power";
var OBJECT_PATH = "/org/cinnamon/SettingsDaemon/Power";

/*
 * The two are the same control with the same calls; they differ only in what
 * StepUp and StepDown answer, and in the keyboard's toggle. Only the parts
 * used here are declared.
 */
const SCREEN_XML = '<node>\
<interface name="org.cinnamon.SettingsDaemon.Power.Screen">\
    <method name="StepUp">\
        <arg type="u" direction="out"/><arg type="i" direction="out"/><arg type="i" direction="out"/>\
    </method>\
    <method name="StepDown">\
        <arg type="u" direction="out"/><arg type="i" direction="out"/><arg type="i" direction="out"/>\
    </method>\
    <method name="GetPercentage"><arg type="u" direction="out"/></method>\
    <method name="SetPercentage"><arg type="u" direction="in"/><arg type="u" direction="out"/></method>\
    <signal name="Changed"/>\
</interface>\
</node>';

const KEYBOARD_XML = '<node>\
<interface name="org.cinnamon.SettingsDaemon.Power.Keyboard">\
    <method name="StepUp"><arg type="u" direction="out"/></method>\
    <method name="StepDown"><arg type="u" direction="out"/></method>\
    <method name="Toggle"><arg type="u" direction="out"/></method>\
    <method name="GetPercentage"><arg type="u" direction="out"/></method>\
    <method name="SetPercentage"><arg type="u" direction="in"/><arg type="u" direction="out"/></method>\
    <signal name="Changed"/>\
</interface>\
</node>';

var SCREEN = "screen";
var KEYBOARD = "keyboard";
var RETRY_INITIAL_MS = 500;
var RETRY_MAX_MS = 8000;

/*
 * Whether DDC/CI is the right way to reach the visible screen.
 *
 * A kernel backlight normally means the built-in panel is available and keeps
 * the I2C probe off the machine. Closing a laptop lid changes that topology:
 * the panel can no longer be seen, so an external monitor is the screen worth
 * controlling. Kept as a plain function because the policy is independent of
 * either D-Bus backend and needs to be checked without a laptop underneath.
 */
function shouldUseMonitorBacklight(enabled, hasKernelBacklight, lidIsClosed) {
    if (!enabled)
        return false;
    if (typeof hasKernelBacklight === "string") {
        if (lidIsClosed)
            return true;
        return hasKernelBacklight === "absent";
    }
    return !hasKernelBacklight || !!lidIsClosed;
}

/* The panel wheel has no row to identify its target, so it must follow the
 * display topology as strictly as the menu does. In closed-lid mode, no DDC
 * answer means no brightness control—not a silent write to the hidden panel. */
function visibleBacklightControl(screen, monitor, externalDisplayMode) {
    if (externalDisplayMode)
        return monitor && monitor.available ? monitor : null;
    if (screen && screen.available)
        return screen;
    return monitor && monitor.available ? monitor : null;
}

const INTERFACES = {};
INTERFACES[SCREEN] = SCREEN_XML;
INTERFACES[KEYBOARD] = KEYBOARD_XML;

/*
 * The one thing this module does on the bus, so that a caller can hand it
 * something else.
 *
 * Every other backend here takes its way out as a parameter - ddc.js a `run`,
 * bluez.js a `call`, privileged.js a `spawn`, cpu.js and power-supply.js a
 * runner and the IO root - which is why each of them has cases that run
 * anywhere. This one built its proxy itself, so nothing but a live settings
 * daemon could exercise it and nothing ever did.
 *
 * A failure to build the proxy at all is reported the same way a failure to
 * connect is, since to everything above they mean the same thing: there is no
 * backlight to be had here.
 */
function connectProxy(xml, onDone, cancellable) {
    try {
        let wrapper = Gio.DBusProxy.makeProxyWrapper(xml);
        new wrapper(Gio.DBus.session, BUS_NAME, OBJECT_PATH, onDone,
                    cancellable || null);
    } catch (error) {
        onDone(null, error);
    }
}

function watchOwner(onAppeared, onVanished, bus) {
    let adapter = bus || Gio;
    return adapter.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
                                  Gio.BusNameWatcherFlags.NONE,
                                  onAppeared, onVanished);
}

function unwatchOwner(id, bus) {
    (bus || Gio).bus_unwatch_name(id);
}

var BacklightControl = class BacklightControl {
    /*
     * onChanged fires when anything else moves this backlight - a function
     * key, the stock applet, the daemon dimming on idle. onReady fires once,
     * when it is known whether there is a backlight here at all. `connect` is
     * how the proxy is reached; see connectProxy above.
     *
     * onReady is handed the control it is about, because it can be called
     * before the caller has one to look at: connectProxy answers from its own
     * catch when the bus cannot even be reached, and that is inside this
     * constructor, so `new BacklightControl(...)` has not returned and nothing
     * the caller wrote down is assigned yet. Asking the argument rather than
     * the field is the difference between "there is no backlight here" and a
     * TypeError in whoever is building these.
     */
    constructor(kind, onChanged, onReady, connect, owner) {
        this.kind = kind;
        this.available = false;
        this.percentage = null;
        this.hardwareState = "unknown";
        this.destroyed = false;

        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._connect = connect || connectProxy;
        this._owner = owner || null;
        this._xml = INTERFACES[kind] || null;
        this._proxy = null;
        this._signalId = 0;
        this._ownerWatch = null;
        this._ownerPresent = false;
        this._retryTimerId = 0;
        this._retryDelay = RETRY_INITIAL_MS;
        this._failures = new Log.FailureLog();
        this._connecting = false;
        this._connectCancellable = null;
        this._connectWaiters = [];
        this._generation = 0;
        this._valueGeneration = 0;
        this._readySent = false;
        this._read = null;
        this._readQueue = [];
        this._mutation = null;
        this._mutationQueue = [];

        if (!this._xml) {
            this.hardwareState = "absent";
            this._settleReady();
            return;
        }

        /* Test connectors are deliberately self-contained. The runtime
         * connector also watches the daemon name so a failed startup is not a
         * permanent hardware decision. */
        let watching = false;
        if (!connect || owner) {
            let install = owner ? owner.watch : watchOwner;
            this._ownerWatch = new OwnerWatch.ResilientOwnerWatch({
                install: (appeared, vanished) => install(appeared, vanished),
                release: id => {
                    if (owner && owner.unwatch)
                        owner.unwatch(id);
                    else
                        unwatchOwner(id);
                },
                appeared: () => this._onOwnerAppeared(),
                vanished: () => this._onOwnerVanished(),
                failures: this._failures,
                failureKey: "owner-watch",
                failureMessage: "cannot watch backlight service ownership",
                timers: {
                    add: (delay, callback) => owner && owner.timeoutAdd
                        ? owner.timeoutAdd(delay, callback)
                        : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback),
                    remove: id => owner && owner.removeTimer
                        ? owner.removeTimer(id) : GLib.source_remove(id),
                },
            });
            watching = this._ownerWatch.start();
        }

        /* Gio's owner watch always reports the current state. Let its initial
         * appeared callback perform the only production GetPercentage read.
         * A custom connector, a custom watcher without that contract, or a
         * failed watch retains the direct startup path. */
        let ownerDriven = owner ? owner.reportsInitialState === true : !connect;
        if (!watching || !ownerDriven)
            this.refresh(() => this._settleReady());
    }

    _settleReady() {
        if (this.destroyed || this._readySent)
            return;
        this._readySent = true;
        this._onReady(this);
    }

    _ensureProxy(onDone) {
        if (this.destroyed) {
            onDone(false);
            return false;
        }
        if (this._proxy) {
            onDone(true);
            return true;
        }
        this._connectWaiters.push(onDone);
        if (this._connecting)
            return true;

        this._connecting = true;
        let generation = ++this._generation;
        let cancellable = null;
        try {
            cancellable = new Gio.Cancellable();
        } catch (e) {
            /* Generation guards retain correctness without cancellation. */
        }
        this._connectCancellable = cancellable;
        this._connect(this._xml, (proxy, error) => {
            if (this.destroyed || generation !== this._generation)
                return;
            this._connectCancellable = null;
            this._connecting = false;
            if (!error && proxy) {
                let signalId = 0;
                try {
                    signalId = proxy.connectSignal(
                        "Changed", () => this.refresh(() => this._onChanged()));
                } catch (signalError) {
                    this._failures.report(
                        "signals",
                        "cannot subscribe to " + this.kind +
                        " backlight changes: " + signalError);
                }
                /* A proxy without its Changed edge is not live state. Leave
                 * it unpublished so the next refresh retries construction. */
                if (signalId) {
                    this._failures.recover("signals");
                    this._proxy = proxy;
                    this._signalId = signalId;
                }
            }
            if (!this._proxy) {
                if (this.hardwareState === "unknown")
                    this.hardwareState = "degraded";
                this._scheduleRetry();
            }
            let waiters = this._connectWaiters.splice(0);
            for (let waiter of waiters)
                waiter(this._proxy !== null);
        }, cancellable);
        return true;
    }

    _dropProxy() {
        let cancellable = this._connectCancellable;
        this._connectCancellable = null;
        ++this._generation;
        ++this._valueGeneration;
        this._connecting = false;
        this._cancelReads();
        this._cancelMutations();
        if (cancellable) {
            try {
                cancellable.cancel();
            } catch (e) {
                /* already cancelled */
            }
        }
        if (this._proxy && this._signalId) {
            try {
                this._proxy.disconnectSignal(this._signalId);
            } catch (e) {
                /* already gone */
            }
        }
        this._proxy = null;
        this._signalId = 0;
        let waiters = this._connectWaiters.splice(0);
        for (let waiter of waiters)
            waiter(false);
    }

    _onOwnerAppeared() {
        if (this.destroyed)
            return;
        this._ownerPresent = true;
        this._cancelRetry();
        let before = this.available;
        this.refresh(() => {
            this._settleReady();
            if (this.available !== before || this.available)
                this._onChanged();
        });
    }

    _onOwnerVanished() {
        if (this.destroyed)
            return;
        this._ownerPresent = false;
        this._failures.clear();
        this._cancelRetry();
        let changed = this.available || this._proxy !== null;
        this._dropProxy();
        this.available = false;
        this.percentage = null;
        this._settleReady();
        if (changed)
            this._onChanged();
    }

    _scheduleRetry() {
        if (this.destroyed || !this._ownerPresent || this._retryTimerId)
            return;
        let delay = this._retryDelay;
        this._retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
        let callback = () => {
            this._retryTimerId = 0;
            if (this.destroyed || !this._ownerPresent)
                return GLib.SOURCE_REMOVE;
            this.refresh(() => {
                if (!this.destroyed) {
                    this._settleReady();
                    this._onChanged();
                }
            });
            return GLib.SOURCE_REMOVE;
        };
        this._retryTimerId = this._owner && this._owner.timeoutAdd
            ? this._owner.timeoutAdd(delay, callback)
            : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback);
    }

    _cancelRetry() {
        if (this._retryTimerId) {
            if (this._owner && this._owner.removeTimer)
                this._owner.removeTimer(this._retryTimerId);
            else
                GLib.source_remove(this._retryTimerId);
            this._retryTimerId = 0;
        }
        this._retryDelay = RETRY_INITIAL_MS;
    }

    /* Asks the daemon where the backlight is now. An error here is the
     * answer to "is there one", not a failure worth reporting. */
    refresh(onDone) {
        let done = onDone || function () {};
        if (this.destroyed) {
            done();
            return false;
        }
        if (!this._proxy) {
            this._ensureProxy(connected => {
                if (!connected)
                    done();
                else
                    this._readPercentage(done);
            });
            return true;
        }
        this._readPercentage(done);
        return true;
    }

    _readPercentage(done) {
        let waiter = this._once(done);
        if (this._read) {
            /* A signal received after this call began means its reply may
             * describe the state before that signal. Keep one follow-up read
             * and let every caller settle from that newer snapshot. */
            this._readQueue.push(waiter);
            ++this._valueGeneration;
            return;
        }
        this._startRead([waiter]);
    }

    _startRead(waiters) {
        if (this.destroyed || !this._proxy) {
            for (let waiter of waiters)
                waiter();
            return;
        }

        let operation = {
            proxy: this._proxy,
            proxyGeneration: this._generation,
            valueGeneration: ++this._valueGeneration,
            waiters: waiters,
        };
        this._read = operation;
        let finish = (result, error) => this._finishRead(operation, result, error);
        try {
            operation.proxy.GetPercentageRemote(finish);
        } catch (error) {
            finish(null, error);
        }
    }

    _finishRead(operation, result, error) {
        if (this._read !== operation) {
            for (let waiter of operation.waiters)
                waiter();
            return;
        }

        this._read = null;
        let queued = this._readQueue.splice(0);
        let sameProxy = !this.destroyed &&
            operation.proxyGeneration === this._generation &&
            operation.proxy === this._proxy;

        /* Coalesced refreshes require a read that began after the latest
         * request. Ignore this answer—even an error—and carry all waiters to
         * the single follow-up read. */
        if (queued.length > 0 && sameProxy) {
            this._startRead(operation.waiters.concat(queued));
            return;
        }

        if (sameProxy && operation.valueGeneration === this._valueGeneration) {
            if (error || !result) {
                this.available = false;
                this.percentage = null;
                if (this.hardwareState === "unknown" ||
                        this.hardwareState === "degraded")
                    this.hardwareState = "absent";
                this._cancelRetry();
                /* A proxy tied to a vanished owner cannot recover its cached
                 * interface reliably. The next refresh builds a fresh one. */
                this._dropProxy();
            } else {
                this.available = true;
                this.percentage = result[0];
                this.hardwareState = "present";
                this._cancelRetry();
            }
        }
        for (let waiter of operation.waiters)
            waiter();
    }

    _once(callback) {
        let called = false;
        return (...args) => {
            if (called)
                return;
            called = true;
            callback(...args);
        };
    }

    _cancelMutations() {
        let current = this._mutation;
        this._mutation = null;
        let queued = this._mutationQueue.splice(0);
        if (current)
            current.settle(current.failureOutcome || { ok: false, cancelled: true });
        for (let operation of queued)
            operation.settle({ ok: false, cancelled: true });
    }

    _cancelReads() {
        let current = this._read;
        this._read = null;
        let queued = this._readQueue.splice(0);
        if (current) {
            for (let waiter of current.waiters)
                waiter();
        }
        for (let waiter of queued)
            waiter();
    }

    /*
     * One mutation reaches the daemon at a time. Slider motion is special: a
     * value still waiting behind another call is replaced by the latest one,
     * because the intermediate point is nowhere the user stopped. Actions on
     * either side of it remain ordered, so set/toggle/step cannot overtake one
     * another and compute from stale state.
     */
    _enqueueMutation(operation) {
        operation.settle = this._once(operation.done);
        if (this.destroyed || !this._proxy) {
            operation.settle({ ok: false, unavailable: true });
            return;
        }

        /* A later mutation owns the next visible value, including while an
         * earlier read or mutation is still in flight. */
        ++this._valueGeneration;

        let last = this._mutationQueue[this._mutationQueue.length - 1];
        if (operation.type === "set" && last && last.type === "set") {
            last.settle({ ok: false, superseded: true });
            this._mutationQueue[this._mutationQueue.length - 1] = operation;
        } else {
            this._mutationQueue.push(operation);
        }
        this._drainMutations();
    }

    _drainMutations() {
        if (this._mutation || this.destroyed || !this._proxy ||
            this._mutationQueue.length === 0)
            return;

        let operation = this._mutationQueue.shift();
        let proxy = this._proxy;
        let generation = this._generation;
        let valueGeneration = ++this._valueGeneration;
        this._mutation = operation;

        let finish = (result, error) => {
            /* Owner loss and destroy settle and detach the operation first. A
             * late D-Bus reply is then only a second answer to the once guard. */
            if (this._mutation !== operation) {
                operation.settle({ ok: false, cancelled: true });
                return;
            }
            let current = !this.destroyed && generation === this._generation &&
                          proxy === this._proxy &&
                          valueGeneration === this._valueGeneration;
            if (current && !error && result) {
                this._mutation = null;
                this.percentage = result[0];
                operation.settle({ ok: true, percentage: this.percentage });
                this._drainMutations();
                return;
            }
            if (!current) {
                this._mutation = null;
                operation.settle({ ok: false, cancelled: true });
                this._drainMutations();
                return;
            }

            let failure = error || new Error("the daemon returned no brightness value");
            let outcome = { ok: false, error: failure };
            operation.failureOutcome = outcome;
            Log.error(this.kind + " backlight " + operation.type +
                      " failed: " + (failure.message || String(failure)));
            this.percentage = null;
            /* The rejected mutation says nothing about the real value. Keep
             * this operation as the queue owner until one fresh read either
             * restores the cache or drops the broken proxy. */
            this._readPercentage(() => {
                if (this._mutation === operation)
                    this._mutation = null;
                operation.settle(outcome);
                if (!this.destroyed)
                    this._onChanged();
                this._drainMutations();
            });
        };

        try {
            if (operation.type === "set") {
                proxy.SetPercentageRemote(operation.value, finish);
            } else if (operation.type === "toggle") {
                proxy.ToggleRemote(finish);
            } else {
                this._runSteps(operation, proxy, generation, valueGeneration, finish);
            }
        } catch (e) {
            finish(null, e);
        }
    }

    _runSteps(operation, proxy, generation, valueGeneration, finish) {
        let remaining = operation.count;
        let latest = null;
        let call = operation.up ? proxy.StepUpRemote : proxy.StepDownRemote;
        let next = (result, error) => {
            if (result !== undefined && !this.destroyed &&
                generation === this._generation && proxy === this._proxy &&
                valueGeneration === this._valueGeneration && !error && result) {
                this.percentage = result[0];
                latest = result;
            }
            if (error || this.destroyed || generation !== this._generation ||
                proxy !== this._proxy || remaining === 0) {
                finish(latest, error);
                return;
            }
            remaining--;
            try {
                call.call(proxy, next);
            } catch (e) {
                finish(null, e);
            }
        };
        next();
    }

    /*
     * Every call here answers its caller exactly once, whatever happened.
     *
     * That is not politeness, it is the contract this class shares with
     * lib/ddc.js: the two stand for the same thing to a slider, to the wheel
     * over the panel and to the middle click, and a control that stays silent
     * when there is no proxy or when the applet went away mid-flight is one a
     * counting caller waits on for ever. DdcBacklight pays for the guarantee
     * per monitor and says so; this said nothing and left three ways out
     * without a word.
     */
    setPercentage(value, onDone) {
        let done = onDone || function () {};
        let wanted = Math.max(0, Math.min(100, Math.round(value)));
        this._enqueueMutation({ type: "set", value: wanted, done: done });
    }

    /*
     * The keyboard backlight's own toggle: off, or back to where it was. Only
     * that interface has it, and on the others this does nothing - and says so,
     * for the reason above.
     */
    toggle(onDone) {
        let done = onDone || function () {};
        if (!this._proxy || typeof this._proxy.ToggleRemote !== "function") {
            done({ ok: false, unavailable: true });
            return;
        }
        this._enqueueMutation({ type: "toggle", done: done });
    }

    /*
     * Several notches, the size of which is the daemon's business.
     *
     * The wheel over the applet gathers a flick before it reaches here, so
     * what arrives is a count rather than one click. They are applied one
     * after another rather than turned into a percentage, because the notch is
     * the daemon's to size and it is the same notch the brightness keys use -
     * the whole reason this goes through the daemon at all. The round trips
     * cost nothing worth avoiding: it is answering from memory.
     */
    stepBy(notches, onDone) {
        let done = onDone || function () {};
        let remaining = Math.abs(Math.round(notches));
        if (!this._proxy) {
            done({ ok: false, unavailable: true });
            return;
        }
        if (remaining === 0) {
            done({ ok: true, noop: true, percentage: this.percentage });
            return;
        }
        this._enqueueMutation({ type: "step", up: notches > 0,
                                count: remaining, done: done });
    }

    /* One notch, which is what the slider's own wheel sends. */
    step(up, onDone) {
        this.stepBy(up ? 1 : -1, onDone);
    }

    destroy() {
        this.destroyed = true;
        this._cancelRetry();
        if (this._ownerWatch)
            this._ownerWatch.stop();
        this._dropProxy();
        this.available = false;
    }
};
