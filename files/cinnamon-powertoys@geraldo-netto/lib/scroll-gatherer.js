/*
 * The wheel counts, and the count is applied once it settles.
 *
 * One flick of a finger sends several clicks. For the power profile each used
 * to be its own D-Bus write, so a flick meant the daemon switching profiles
 * two or three times in a few tens of milliseconds, and that is why this
 * gathering exists.
 *
 * The brightness did not gather, and needed it more. On a kernel backlight the
 * daemon queues the steps and nothing is lost; on a monitor over DDC/CI each
 * step reads a percentage that has not moved yet and a second write while the
 * first is in flight is refused, so a five-notch flick moved one notch and the
 * other four went nowhere.
 *
 * The applet's wheel handler and the brightness slider both do this, so it is
 * written here once, where a case can drive the timer instead of waiting a
 * quarter of a second for the compositor.
 */

const GLib = imports.gi.GLib;

const Backoff = require("./lib/backoff.js");

/* Long enough to gather a flick, short enough that the change still feels
 * immediate. */
const SETTLE_MS = 250;

/* A wheel notch is one step; a smooth-scrolling device sends fractions of
 * one, and it is their total that is a step. Rounded towards zero's own side
 * so a flick down is as many steps as the same flick up. */
function settledSteps(amount) {
    return amount < 0 ? -Math.round(-amount) : Math.round(amount);
}

const ScrollGatherer = class ScrollGatherer {
    /* `apply(steps)` receives the settled count, and is never called with
     * zero. `timers` is any object with add(delay, callback)/remove(id);
     * the default is GLib's main loop. */
    constructor(options) {
        options = options || {};
        this._apply = options.apply || function () {};
        this._settleMs = options.settleMs || SETTLE_MS;
        this._timers = Backoff.timerPort(options.timers);
        this._pending = 0;
        this._timerId = 0;
    }

    /* Another notch. The settle window restarts, so a flick is applied once
     * it has stopped rather than once it has started. */
    gather(amount) {
        this._pending += amount;
        this._cancelTimer();
        this._timerId = this._timers.add(this._settleMs, () => {
            this._timerId = 0;
            let steps = settledSteps(this._pending);
            this._pending = 0;
            if (steps !== 0)
                this._apply(steps);
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Teardown: the timer is owned here, and a gathered flick that never
     * settles is dropped rather than applied to a destroyed control. */
    cancel() {
        this._cancelTimer();
        this._pending = 0;
    }

    _cancelTimer() {
        if (this._timerId) {
            try {
                this._timers.remove(this._timerId);
            } catch (error) {
                /* already removed */
            }
            this._timerId = 0;
        }
    }
};
