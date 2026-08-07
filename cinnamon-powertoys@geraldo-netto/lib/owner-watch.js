/*
 * A recoverable D-Bus name-watch registration.
 *
 * A name watcher is lifecycle wiring, not a one-shot discovery call. If its
 * registration fails, a direct proxy probe can preserve the current state but
 * cannot report the next daemon stop or restart. This boundary keeps retrying
 * the missing edge with capped backoff, says so once per continuous failure,
 * and owns both the retry timer and the eventual watch handle at teardown.
 */

const GLib = imports.gi.GLib;
const Log = require("./lib/log.js");

const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30000;

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
        this._timers = options.timers || {
            add: (delay, callback) =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback),
            remove: id => GLib.source_remove(id),
        };
        this._handle = null;
        this._timerId = 0;
        this._retryDelay = options.retryInitialMs || RETRY_INITIAL_MS;
        this._retryInitial = options.retryInitialMs || RETRY_INITIAL_MS;
        this._retryMax = options.retryMaxMs || RETRY_MAX_MS;
        this._stopped = false;
    }

    start() {
        if (this._stopped || this._handle)
            return !!this._handle;
        /* A caller checking degraded wiring must not bypass the backoff. */
        if (this._timerId)
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
            this._retryDelay = this._retryInitial;
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
        if (this._stopped || this._handle || this._timerId)
            return;
        let delay = this._retryDelay;
        this._retryDelay = Math.min(delay * 2, this._retryMax);
        this._timerId = this._timers.add(delay, () => {
            this._timerId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    get active() {
        return this._handle !== null;
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        if (this._timerId) {
            try {
                this._timers.remove(this._timerId);
            } catch (error) {
                /* already removed */
            }
            this._timerId = 0;
        }
        if (this._handle) {
            try {
                this._release(this._handle);
            } catch (error) {
                /* already released */
            }
            this._handle = null;
        }
        this._retryDelay = this._retryInitial;
    }
};
