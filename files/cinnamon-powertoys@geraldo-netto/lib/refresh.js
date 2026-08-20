/*
 * One sweep at a time, one replay however many callers asked, and every caller
 * answered exactly once.
 *
 * Three backends look for hardware that has come or gone - the processor, the
 * charge thresholds, the sensors - and all three had to solve the same problem:
 * a sweep takes long enough that another request arrives during it, and that
 * request cannot be answered from a sweep which began before it. All three
 * solved it the same way, with a boolean for "running", a boolean for "one more
 * afterwards", a list of waiters and a flag for whether anything moved, and all
 * three wrote it out again.
 *
 * Three copies of a concurrency rule is three places for it to be subtly
 * different, and it was: one answered its callers whether anything had changed,
 * the other two answered a literal true, and one announced a change on every
 * sweep whether or not there had been one, so a rediscovery that found the same
 * machine still repainted the applet.
 *
 * The rule is here now, with no filesystem, no bus and no clock in it: a sweep
 * is a function that answers, and everything else is bookkeeping a case can
 * drive directly.
 */

/*
 * `sweep(done)` does the work and calls `done(changed)`. It is called again for
 * a replay, so it must read the machine afresh each time rather than close over
 * one answer.
 *
 * `onChanged()` is called after a settled sweep that changed something - never
 * for a superseded one, whose answer describes a machine that has already been
 * asked about again.
 *
 * `defer()` is an optional second reason to queue rather than start: the sensor
 * inventory will not begin a topology check while its first full discovery is
 * still in flight. A caller that defers is responsible for calling `resume()`
 * when its reason has passed, or the queued sweep waits for the next request.
 */
const Coalescer = class Coalescer {
    constructor(options) {
        options = options || {};
        this._sweep = options.sweep || function (done) { done(false); };
        this._onChanged = options.onChanged || function () {};
        this._defer = options.defer || function () { return false; };
        this._running = false;
        this._again = false;
        this._changed = false;
        this._waiters = [];
        this._stopped = false;
    }

    /* Whether a sweep is in flight. */
    get running() {
        return this._running;
    }

    /* Whether a replay is owed. */
    get pending() {
        return this._again;
    }

    /* Whether anything may still be accepted. */
    get stopped() {
        return this._stopped;
    }

    /*
     * Ask for a sweep. Answers whether the request was accepted, which is
     * everything except after teardown; `onDone(changed)` is called once, when
     * a sweep that observes this request has settled, or with false at
     * teardown.
     */
    request(onDone) {
        if (this._stopped) {
            if (onDone)
                onDone(false);
            return false;
        }
        if (onDone)
            this._waiters.push(onDone);
        if (this._running || this._defer()) {
            /* One replay covers every caller that arrived during this sweep;
             * a second queued sweep would observe nothing the first does not. */
            this._again = true;
            return true;
        }
        this._start();
        return true;
    }

    /* Start a queued replay whose reason for waiting has passed. Nothing to do
     * where none is owed, or where one is already running. */
    resume() {
        if (this._stopped || this._running || !this._again || this._defer())
            return false;
        this._again = false;
        this._start();
        return true;
    }

    _start() {
        this._running = true;
        this._sweep(changed => this._settle(changed));
    }

    _settle(changed) {
        if (this._stopped)
            return;
        /* What a superseded sweep saw still counts: it is part of what the
         * caller waiting behind it is being told about. */
        this._changed = this._changed || !!changed;
        if (this._again) {
            this._again = false;
            this._start();
            return;
        }
        this._running = false;
        let result = this._changed;
        this._changed = false;
        let waiters = this._waiters.splice(0);
        for (let waiter of waiters)
            waiter(result);
        if (result)
            this._onChanged();
    }

    /*
     * Teardown. Every caller accepted while this still existed is answered
     * once, unsuccessfully: a cancelled read may never reach its ordinary
     * completion, and a caller left waiting on one is a caller left waiting.
     *
     * A waiter that throws must not strand the ones behind it - teardown goes
     * on to release other backends - so the first throw is answered back to the
     * caller rather than propagated, and the rest of the waiters still run.
     */
    stop() {
        if (this._stopped)
            return null;
        this._stopped = true;
        this._running = false;
        this._again = false;
        this._changed = false;
        this._onChanged = function () {};
        let firstError = null;
        for (let waiter of this._waiters.splice(0)) {
            try {
                waiter(false);
            } catch (error) {
                firstError = firstError || error;
            }
        }
        return firstError;
    }
};
