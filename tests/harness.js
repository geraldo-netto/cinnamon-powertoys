/*
 * Test harness.
 *
 * Two jobs. The first is loading the applet's libraries the way Cinnamon
 * loads them, which is the only reason a test can touch them at all: strict
 * mode, exports gathered by the same regex, and a require() bound to the xlet
 * directory. Getting that wrong would mean testing something the shell never
 * runs.
 *
 * The second is a handful of assertions. They throw; the runner catches and
 * reports. That is the whole contract.
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

var UUID = "cinnamon-powertoys@geraldo-netto";

/* Set by the runner, which is the only thing that knows where it was run from. */
var ROOT = null;

function setRoot(path) {
    ROOT = path;
}

function xletDir() {
    return ROOT + "/" + UUID;
}

function testsDir() {
    return ROOT + "/tests";
}

function _decode(bytes) {
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

/*
 * The names Cinnamon's loader refuses to re-export, because they are its own
 * import namespaces rather than anything the module defined. Kept in step
 * with misc/fileUtils.js.
 */
const IMPORT_NAMES = ["mainloop", "jsunit", "format", "signals", "lang", "tweener",
                      "overrides", "gettext", "coverage", "package", "cairo",
                      "byteArray", "cationative", "caironative"];

function _giNames() {
    try {
        let repository = imports.gi.GIRepository.Repository;
        let instance = repository.dup_default ? repository.dup_default() : repository.get_default();
        return instance.get_loaded_namespaces();
    } catch (e) {
        return ["Gio", "GLib", "St", "Clutter", "UPowerGlib", "GObject", "Gtk", "Gdk"];
    }
}

let _cache = {};

/*
 * The same resolution rule Cinnamon uses: relative paths are stripped of
 * their "./" and joined onto the xlet directory, never onto the directory of
 * the file doing the requiring. That is why every lib says
 * require("./lib/x.js") even from inside lib/.
 */
function requireXlet(path) {
    if (path.substr(-3) !== ".js")
        path += ".js";
    if (path[0] === "." || path[0] !== "/")
        path = xletDir() + "/" + path.replace(/\.\//g, "");
    if (_cache[path])
        return _cache[path];

    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("cannot read " + path);

    let JS = "'use strict';" + _decode(bytes) + ";";
    const exportsRegex = /^module\.exports(\.[a-zA-Z0-9_$]+)?\s*=/m;
    const varRegex = /^(?:'use strict';){0,}(const|var|let|function|class)\s+([a-zA-Z0-9_$]+)/gm;
    let gi = _giNames();
    let match;
    if (!exportsRegex.test(JS)) {
        while ((match = varRegex.exec(JS)) !== null) {
            if (match.index === varRegex.lastIndex)
                varRegex.lastIndex++;
            if (match[2] && IMPORT_NAMES.indexOf(match[2].toLowerCase()) === -1 &&
                gi.indexOf(match[2]) === -1)
                JS += "exports." + match[2] + " = typeof " + match[2] +
                      " !== 'undefined' ? " + match[2] + " : null;";
        }
    }
    JS += "return module.exports;";

    let exports = {};
    let module = { exports: exports };
    let meta = { uuid: UUID, path: xletDir() };
    _cache[path] = new Function("require", "exports", "module",
                                "__meta", "__dirname", "__filename", JS)
        .call(exports, requireXlet, exports, module, meta, xletDir(), path);
    return _cache[path];
}

/* ---------------------------------------------------------------- */
/* assertions                                                        */

function fail(what) {
    throw new Error(what);
}

function ok(value, what) {
    if (!value)
        fail(what + ": expected something truthy, got " + _show(value));
}

function equal(actual, expected, what) {
    if (actual !== expected)
        fail(what + ": expected " + _show(expected) + ", got " + _show(actual));
}

/* Floating point, so a comparison needs a width. */
function near(actual, expected, tolerance, what) {
    if (typeof actual !== "number" || Math.abs(actual - expected) > tolerance)
        fail(what + ": expected " + expected + " +/- " + tolerance + ", got " + _show(actual));
}

function deepEqual(actual, expected, what) {
    let a = JSON.stringify(actual);
    let b = JSON.stringify(expected);
    if (a !== b)
        fail(what + ": expected " + b + ", got " + a);
}

function throws(body, what) {
    try {
        body();
    } catch (e) {
        return;
    }
    fail(what + ": expected it to throw, it did not");
}

function _show(value) {
    if (typeof value === "string")
        return '"' + value + '"';
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

/* ---------------------------------------------------------------- */
/* fixtures                                                          */

/* A captured /sys tree the IO layer can be pointed at. */
function fixture(name) {
    return testsDir() + "/fixtures/" + name;
}

function fixtureExists(name) {
    return Gio.File.new_for_path(fixture(name)).query_exists(null);
}
