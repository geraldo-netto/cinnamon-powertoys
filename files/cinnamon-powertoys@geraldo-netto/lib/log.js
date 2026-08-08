/*
 * cinnamon-powertoys - where trouble gets reported.
 *
 * The libraries used to call Cinnamon's global.logError directly, which meant
 * they could not be loaded at all outside the shell: anything that wanted to
 * exercise them had to invent a global object first, and that is exactly the
 * kind of obstacle that stops a library being tested.
 *
 * Nothing here decides what the user sees. These are notes for whoever reads
 * the log afterwards; a failure the user needs to know about is reported by
 * the caller, which is the only one that knows what it means.
 */

let _sink = null;

/* Hands the messages somewhere else - a test collecting them, say. */
function setSink(sink) {
    _sink = sink || null;
}

function error(message) {
    let line = "[powertoys] " + message;
    if (_sink) {
        _sink(line);
        return;
    }
    /* Inside Cinnamon this goes to ~/.xsession-errors with a stack trace. */
    if (typeof global !== "undefined" && global && typeof global.logError === "function") {
        global.logError(line);
        return;
    }
    /* Outside it, plain cjs still has somewhere to put it. */
    if (typeof printerr === "function")
        printerr(line);
}

/*
 * One line for one continuous failure.
 *
 * Backoff keeps a broken service from being called in a tight loop; it does
 * not by itself keep every retry from saying the same thing. Each owner keeps
 * one of these, reports a keyed transition into failure, and clears that key
 * when the operation succeeds again. `clear()` ends every failure when a
 * daemon disappears, so a later daemon instance gets one useful diagnostic of
 * its own rather than inheriting the old one's silence.
 */
const FailureLog = class FailureLog {
    constructor() {
        this._active = new Set();
    }

    report(key, message) {
        key = String(key);
        if (this._active.has(key))
            return false;
        this._active.add(key);
        error(message);
        return true;
    }

    recover(key) {
        return this._active.delete(String(key));
    }

    clear() {
        this._active.clear();
    }
};
