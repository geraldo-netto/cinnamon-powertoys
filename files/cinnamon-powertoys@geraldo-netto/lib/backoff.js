/*
 * One capped-doubling retry timer.
 *
 * Every D-Bus backend here recovers the same way: when a connect, a read or a
 * registration fails while the thing it talks to still exists, try again after
 * a delay that doubles up to a ceiling, and forget the delay once the reason
 * to retry is gone. That shape was written out five times - in upower.js,
 * bluez.js, backlight.js, profiles.js and owner-watch.js - each around its own
 * timer convention and its own may-I-run predicate, so a correction to the
 * backoff had to be made five times. It is written here once instead.
 *
 * The predicate is asked twice: before arming, so a backend with no reason to
 * retry arms nothing, and again when the timer fires, so a backend torn down
 * while the timer was pending runs nothing.
 */

const GLib = imports.gi.GLib;

const INITIAL_MS = 1000;
const MAX_MS = 30000;

/*
 * What a backend that talks to a daemon by name waits, which is not the
 * general default above.
 *
 * A daemon that has just gone is usually a daemon that is coming straight
 * back - a package upgrade restarting it, a session service started late - so
 * the first retry is soon enough that the applet has it again before anybody
 * looks, and the ceiling is low enough that a machine which will never run
 * that daemon still costs one wakeup every eight seconds and no more. All
 * four of the bus backends had settled on the same pair separately, which is
 * one decision written four times rather than four decisions.
 */
const BUS_INITIAL_MS = 500;
const BUS_MAX_MS = 8000;

/*
 * The timer conventions a backend may already hold: an already-shaped port
 * (`add`/`remove`), a bus (`timeoutAdd`/`removeTimer`) or a GLib-shaped object
 * (`timeout_add`/`source_remove`). Anything unanswered falls back to GLib's
 * main loop, which is what every production caller uses.
 *
 * `options.seconds` picks GLib's second-resolution timer for a delay that is
 * counted in seconds rather than milliseconds - a probe once a minute has no
 * business waking the process on a millisecond boundary. It changes only the
 * fallback: a source that answered has already decided its own unit.
 */
function timerPort(source, options) {
    source = source || {};
    let seconds = !!(options && options.seconds);
    return {
        add: (delay, callback) => {
            if (typeof source.add === "function")
                return source.add(delay, callback);
            if (typeof source.timeoutAdd === "function")
                return source.timeoutAdd(delay, callback);
            if (typeof source.timeout_add === "function")
                return source.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback);
            return seconds
                ? GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, callback)
                : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback);
        },
        remove: id => {
            if (typeof source.remove === "function")
                return source.remove(id);
            if (typeof source.removeTimer === "function")
                return source.removeTimer(id);
            if (typeof source.source_remove === "function")
                return source.source_remove(id);
            return GLib.source_remove(id);
        },
    };
}

const Backoff = class Backoff {
    constructor(options) {
        options = options || {};
        this._timers = timerPort(options.timers);
        this._initial = options.initialMs || INITIAL_MS;
        this._max = options.maxMs || MAX_MS;
        this._allow = options.allow || (() => true);
        this._run = options.run || function () {};
        this._delay = this._initial;
        this._timerId = 0;
    }

    /* True while a retry is armed. A caller deciding whether to take a
     * direct path must not treat a pending retry as an idle backend. */
    get pending() {
        return this._timerId !== 0;
    }

    /* The delay the next arming would use. */
    get delay() {
        return this._delay;
    }

    schedule() {
        if (this._timerId || !this._allow())
            return false;
        let delay = this._delay;
        this._delay = Math.min(delay * 2, this._max);
        this._timerId = this._timers.add(delay, () => {
            this._timerId = 0;
            if (this._allow())
                this._run();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    /* Drop any armed retry and start the next sequence from the floor. */
    cancel() {
        if (this._timerId) {
            try {
                this._timers.remove(this._timerId);
            } catch (error) {
                /* already removed */
            }
            this._timerId = 0;
        }
        this._delay = this._initial;
    }
};
