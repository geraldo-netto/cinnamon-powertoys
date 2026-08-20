/*
 * When to go looking for a monitor on a cable, and how often.
 *
 * Three separate questions decide whether a DDC/CI probe is worth its cost,
 * and each of them moves at its own moment: the setting, whether this machine
 * has a backlight of its own (the settings daemon answers that, sometimes
 * late), and whether the lid is closed (UPower says so at any time). On top of
 * those sits a set of reasons somebody is looking at the applet - a tooltip, an
 * open menu - which overlap, because the tooltip goes away as the menu opens
 * under the pointer.
 *
 * That is a state machine, and it was spread across seven applet methods and
 * four fields where nothing could drive it but a running Cinnamon. It is here
 * so a case can move the lid, answer for the daemon, open the menu and tick the
 * timer, and so the applet is left holding only the parts that need a shell:
 * spawning ddcutil, and starting or stopping the control.
 */

const GLib = imports.gi.GLib;

const Backoff = require("./lib/backoff.js");

const Backlight = require("./lib/backlight.js");

/*
 * How often monitors are looked for while somebody is looking at the applet.
 *
 * A probe spawns ddcutil, talks to every display on the I2C bus and wakes a
 * sleeping one, which is why this is not on the applet's poll and why the timer
 * does not exist unless there is a reason for it. A second is what a monitor
 * that was asleep, plugged in unnoticed or slow to answer costs before its
 * slider appears, which is about as long as somebody who has just opened the
 * menu will wait without deciding the applet cannot see it.
 */
const PROBE_SECONDS = 1;

/* The reason that owns the recurring timer. A tooltip is worth one warm-up
 * probe and no more; see watch(). */
const RECURRING_REASON = "menu";

const MonitorWatch = class MonitorWatch {
    /*
     * `enabled()` reads the setting, `onProbe()` performs one look, and
     * `onScopeChanged(wanted)` starts or stops the control that does the
     * looking. `timers` is any object with add(seconds, callback)/remove(id);
     * the default is GLib's main loop.
     */
    constructor(options) {
        options = options || {};
        this._enabled = options.enabled || function () { return false; };
        this._probe = options.onProbe || function () {};
        this._scopeChanged = options.onScopeChanged || function () {};
        this._intervalSeconds = options.intervalSeconds || PROBE_SECONDS;
        this._timers = Backoff.timerPort(options.timers, { seconds: true });

        /* Why monitors are being looked for. Empty means nobody is looking at
         * the applet. */
        this._reasons = new Set();
        this._timerId = 0;
        /*
         * Which probe timer is the current one; see lib/poll.js, which has
         * the same pair of problems and the same answer. Clearing `_timerId`
         * and then asking the main loop to remove it is one half of stopping
         * a repeating source, and it is the half a collaborator can refuse -
         * at which point the id is already gone and a callback that answers
         * SOURCE_CONTINUE whatever has happened keeps the source, and the
         * closure over this watch, for the rest of the session.
         */
        this._generation = 0;
        this._destroyed = false;
        /* Whether this machine has a backlight of its own, as the settings
         * daemon answered it - "unknown" until it has. */
        this._kernelBacklightState = "unknown";
        /* UPower owns the live lid state. False is deliberately conservative
         * until its manager proxy says otherwise. */
        this._lidClosed = false;
    }

    get kernelBacklightState() {
        return this._kernelBacklightState;
    }

    get lidClosed() {
        return this._lidClosed;
    }

    /* A built-in panel that exists but is not the visible screen: the external
     * monitors are the controls worth drawing and worth driving. */
    get externalDisplayMode() {
        return this._kernelBacklightState === "present" && this._lidClosed;
    }

    /*
     * Whether looking for a monitor could find one worth having.
     *
     * The setting says whether this is wanted at all. A usable built-in panel
     * keeps DDC off the machine; when the lid is closed that panel is no longer
     * the visible screen and the external monitors become the controls worth
     * finding.
     */
    get canProbe() {
        return Backlight.shouldUseMonitorBacklight(
            !!this._enabled(), this._kernelBacklightState, this._lidClosed);
    }

    /*
     * The settings daemon has answered, or answered differently. Reports
     * whether the answer moved, because only a move is worth acting on.
     */
    setKernelBacklightState(state) {
        if (state === this._kernelBacklightState)
            return false;
        this._kernelBacklightState = state;
        return true;
    }

    setLidClosed(closed) {
        closed = !!closed;
        if (closed === this._lidClosed)
            return false;
        this._lidClosed = closed;
        return true;
    }

    /*
     * Ask again whether monitors are worth reaching for at all, and arm or drop
     * the timer from the answer.
     *
     * Called both when a fact changes and when the setting is switched: start()
     * is expected to be idempotent, so asking again costs nothing when the
     * control is already running, and switching the setting off has to reach
     * the control or the sliders stay in the menu against a setting that says
     * they should not.
     */
    syncScope() {
        this._scopeChanged(this.canProbe);
        this.considerProbing();
    }

    /*
     * Somebody started, or stopped, looking at the applet.
     *
     * A tooltip contains no monitor data, so it gets a single warm-up probe -
     * enough to make a subsequent menu open current without turning an
     * accidental hover into recurring I2C traffic. Only the open menu owns the
     * recurring timer.
     */
    watch(reason, wanted) {
        let alreadyWanted = this._reasons.has(reason);
        if (wanted)
            this._reasons.add(reason);
        else
            this._reasons.delete(reason);

        if (reason !== RECURRING_REASON && wanted && !alreadyWanted &&
            !this._reasons.has(RECURRING_REASON))
            this.probeNow();
        this.considerProbing();
    }

    /*
     * Arm the timer, or drop it, from what is true now.
     *
     * Two things have to hold for it to exist: somebody is looking, and there
     * is something a look could find. The second is asked here rather than
     * inside the tick, because a machine with a kernel backlight of its own -
     * which is every laptop, and the common case - would otherwise run a timer
     * whose every tick did nothing at all for as long as the menu was open.
     *
     * The first probe goes out at once rather than an interval later. Whatever
     * has just given a reason is being looked at now, and a slider that appears
     * a second after the menu opens is a slider that was not there when it was
     * looked for.
     */
    considerProbing() {
        if (this._destroyed || !this._reasons.has(RECURRING_REASON) ||
            !this.canProbe) {
            this.stopProbing();
            return;
        }
        if (this._timerId)
            return;

        this.probeNow();
        let generation = this._generation;
        this._timerId = this._timers.add(this._intervalSeconds, () => {
            if (this._destroyed || this._generation !== generation)
                return GLib.SOURCE_REMOVE;
            this.probeNow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /*
     * One look, from wherever the reason came from - the desktop's own
     * monitors-changed signal included.
     *
     * A probe that lands while ddcutil is already talking to this machine is
     * coalesced by the control into one follow-up, so nothing here has to know
     * how long ddcutil is taking or what else is on the bus.
     */
    probeNow() {
        if (!this._destroyed && this.canProbe)
            this._probe();
    }

    stopProbing() {
        /* Before the removal, and whether or not there is anything to remove:
         * this is the half of stopping that cannot be refused. */
        this._generation++;
        if (this._timerId) {
            let id = this._timerId;
            this._timerId = 0;
            try {
                this._timers.remove(id);
            } catch (error) {
                /* An id the main loop has already retired. The generation
                 * above has already ended this timer. */
            }
        }
    }

    /* Teardown: the timer is owned here, and nothing may probe afterwards. */
    destroy() {
        this._destroyed = true;
        this.stopProbing();
    }
};
