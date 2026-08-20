/*
 * The clock this applet runs on.
 *
 * Three things, all of them a timer and a counter, and all of them stranded in
 * applet.js where nothing without a shell could reach them: the interval that
 * takes a reading, the slower count inside it that decides when to look for
 * hardware that has come or gone, and the idle callback that turns several
 * reasons to redraw arriving at once into one redraw.
 *
 * So "a poll fires a rediscovery once a minute and not once a second" and "a
 * redraw asked for four times before the main loop is idle happens once" had no
 * case, and could not have one: they are true of a running session or of
 * nothing.
 *
 * Every timer is the caller's, handed in. GLib's main loop is what the applet
 * passes; a case passes something it can advance itself.
 */

/* How long between sweeps for hardware that has come or gone. A card that
 * wakes up, a USB sensor plugged in, a driver loaded: opening the menu used to
 * be the only thing that noticed, which since the menu stopped updating while
 * shut meant the panel could go the whole session without seeing it. */
const REDISCOVER_SECONDS = 60;

const Poll = class Poll {
    /*
     * `timers` needs four members: add(seconds, callback) and remove(id) for
     * the interval, and idle(callback) and cancelIdle(id) for the coalesced
     * redraw. The interval callback's return value is the caller's convention,
     * so `repeat` and `once` say what to answer with.
     *
     * `onTick()` is called every interval, `onRediscover()` when the slower
     * count comes round, and always before the tick it shares.
     */
    constructor(options) {
        options = options || {};
        /* A loop with no timers runs nothing rather than throwing: this is
         * constructed inside an applet constructor, and a throw there takes
         * the applet off the panel with nothing but a stack to go on. */
        let timers = options.timers || {};
        this._timers = {
            add: timers.add || function () { return 0; },
            remove: timers.remove || function () {},
            idle: timers.idle || function () { return 0; },
            cancelIdle: timers.cancelIdle || function () {},
        };
        this._onTick = options.onTick || function () {};
        this._onRediscover = options.onRediscover || function () {};
        this._rediscoverSeconds = options.rediscoverSeconds || REDISCOVER_SECONDS;
        this._repeat = options.repeat;
        this._once = options.once;
        this._timerId = 0;
        this._idleId = 0;
        this._elapsed = 0;
    }

    get running() {
        return this._timerId !== 0;
    }

    /* Seconds between readings. Starting an already-running loop replaces it,
     * which is what a changed interval setting has to do. */
    start(seconds) {
        this.stop();
        let interval = Math.max(1, seconds || 1);
        this._elapsed = 0;
        this._timerId = this._timers.add(interval, () => {
            this._elapsed += interval;
            if (this._elapsed >= this._rediscoverSeconds) {
                this._elapsed = 0;
                this._onRediscover();
            }
            this._onTick();
            return this._repeat;
        });
    }

    stop() {
        if (!this._timerId)
            return;
        let id = this._timerId;
        this._timerId = 0;
        this._timers.remove(id);
    }

    /*
     * One tick at the next idle moment, however many times it is asked for.
     *
     * Several backends answering at once is several reasons to redraw and one
     * redraw worth doing, and the reasons arrive from D-Bus replies that have
     * no idea about each other.
     */
    schedule() {
        if (this._idleId)
            return false;
        this._idleId = this._timers.idle(() => {
            this._idleId = 0;
            this._onTick();
            return this._once;
        });
        return true;
    }

    /* Somebody just looked: the machine has been swept for other reasons, so
     * the slower count starts again rather than firing seconds later. */
    seen() {
        this._elapsed = 0;
    }

    /* Teardown. A scheduled tick that has not fired is dropped rather than
     * delivered to an applet that has left the panel. */
    destroy() {
        this.stop();
        if (!this._idleId)
            return;
        let id = this._idleId;
        this._idleId = 0;
        this._timers.cancelIdle(id);
    }
};
