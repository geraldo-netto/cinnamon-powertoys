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
