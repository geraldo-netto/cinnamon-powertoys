/* One exception-safe boundary around Cinnamon's notification API. */

const Log = require("./lib/log.js");

const NotificationCenter = class NotificationCenter {
    constructor(shell) {
        this._shell = shell || {};
        this._failures = new Log.FailureLog();
    }

    _send(method, title, body) {
        try {
            let send = this._shell[method];
            if (typeof send !== "function")
                throw new Error(method + " is unavailable");
            send.call(this._shell, title, body);
            this._failures.recover(method);
            return true;
        } catch (error) {
            this._failures.report(method, method + " failed: " + error);
            return false;
        }
    }

    notify(title, body) {
        return this._send("notify", title, body);
    }

    error(title, body) {
        return this._send("notifyError", title, body);
    }

    critical(title, body) {
        return this._send("criticalNotify", title, body);
    }
};
