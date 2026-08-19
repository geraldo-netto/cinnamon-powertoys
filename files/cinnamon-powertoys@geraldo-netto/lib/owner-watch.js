/*
 * A recoverable D-Bus name-watch registration.
 *
 * A name watcher is lifecycle wiring, not a one-shot discovery call. If its
 * registration fails, a direct proxy probe can preserve the current state but
 * cannot report the next daemon stop or restart. This boundary keeps retrying
 * the missing edge with capped backoff, says so once per continuous failure,
 * and owns both the retry timer and the eventual watch handle at teardown.
 */

const Log = require("./lib/log.js");
const Backoff = require("./lib/backoff.js");

const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30000;

/* The timer conventions a backend may already hold live with the backoff
 * that consumes them; watches accept exactly the same shapes. */
const timerPort = Backoff.timerPort;

/*
 * Build a watch from a backend's own collaborators: `timers` is whatever
 * object that backend already holds, not a pre-shaped port.
 */
function watchOwnership(options) {
    return new ResilientOwnerWatch(options);
}

const ResilientOwnerWatch = class ResilientOwnerWatch {
    constructor(options) {
        options = options || {};
        this._install = options.install;
        this._release = options.release || function () {};
        this._appeared = options.appeared || function () {};
        this._vanished = options.vanished || function () {};
        this._onInstalled = options.onInstalled || function () {};
        this._onFailed = options.onFailed || function () {};
        this._failures = options.failures || new Log.FailureLog();
        this._failureKey = options.failureKey || "owner-watch";
        this._failureMessage = options.failureMessage || "cannot watch service ownership";
        this._timers = options.timers || null;
        this._handle = null;
        this._stopped = false;
        this._retry = new Backoff.Backoff({
            timers: this._timers,
            initialMs: options.retryInitialMs || RETRY_INITIAL_MS,
            maxMs: options.retryMaxMs || RETRY_MAX_MS,
            allow: () => !this._stopped && !this._handle,
            run: () => this.start(),
        });
    }

    start() {
        if (this._stopped || this._handle)
            return !!this._handle;
        /* A caller checking degraded wiring must not bypass the backoff. */
        if (this._retry.pending)
            return false;

        let reported = false;
        let appeared = (...args) => {
            if (this._stopped)
                return;
            reported = true;
            this._appeared(...args);
        };
        let vanished = (...args) => {
            if (this._stopped)
                return;
            reported = true;
            this._vanished(...args);
        };

        try {
            let handle = this._install(appeared, vanished);
            if (!handle)
                throw new Error("watch registration returned no handle");
            this._handle = handle;
            this._retry.cancel();
            this._failures.recover(this._failureKey);
            this._onInstalled(reported);
            return true;
        } catch (error) {
            this._onFailed(error);
            this._failures.report(
                this._failureKey, this._failureMessage + ": " + error);
            this._scheduleRetry();
            return false;
        }
    }

    _scheduleRetry() {
        this._retry.schedule();
    }

    get active() {
        return this._handle !== null;
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        this._retry.cancel();
        if (this._handle) {
            try {
                this._release(this._handle);
            } catch (error) {
                /* already released */
            }
            this._handle = null;
        }
    }
};
