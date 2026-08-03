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

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

/* The loader emulation the parse check uses as well, so the two cannot come
 * to disagree about what Cinnamon does. The runner puts tools/ on the path. */
const Loader = imports.loader;

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

    let exports = {};
    let module = { exports: exports };
    let meta = { uuid: UUID, path: xletDir() };
    _cache[path] = _compile(path)
        .call(exports, requireXlet, exports, module, meta, xletDir(), path);
    return _cache[path];
}

/* ---------------------------------------------------------------- */
/* coverage                                                          */

/*
 * Where a coverage run puts the copies it measures, or null in an ordinary
 * run. The runner reads it out of the environment and says so here.
 *
 * cjs measures what it compiles from a file, and a library here is compiled
 * out of a string by new Function - which is how Cinnamon does it, and which
 * leaves the interpreter with no filename to attribute a line to. So a
 * coverage run writes each library out again, one file per library, and loads
 * that instead.
 */
let _coverageDir = null;
let _coverageNames = {};

function setCoverageDir(path) {
    _coverageDir = path || null;
}

function coverageDir() {
    return _coverageDir;
}

/*
 * The module name a library is measured under. Directory separators and dots
 * are not identifiers, and `imports.x` needs one.
 */
function _coverageName(path) {
    return "cov_" + path.slice(xletDir().length + 1).replace(/[^A-Za-z0-9]/g, "_");
}

/*
 * The body Cinnamon evaluates, in a file, wrapped in the function it is
 * evaluated as.
 *
 * The wrapper opens on the same line the body does, so every line after the
 * first is where it is in the original and a coverage record can be read
 * against the real source without an offset. What is inside the wrapper is
 * exactly Loader.moduleBody - the same text new Function is handed in an
 * ordinary run - so the two runs measure and exercise the same program.
 */
function _coverageBody(source) {
    return "var __xlet = function (" + Loader.PARAMETERS.join(", ") + ") {" +
           Loader.moduleBody(source) + "};";
}

function _compile(path) {
    let source = Loader.read(path);
    if (!_coverageDir)
        return Loader.compile(Loader.moduleBody(source));

    let name = _coverageName(path);
    _coverageNames[name] = path;
    GLib.file_set_contents(_coverageDir + "/" + name + ".js", _coverageBody(source));
    return imports[name].__xlet;
}

/*
 * Which real file each measured copy stands for.
 *
 * Written out rather than worked out again by the report: the name is what a
 * path comes to once everything that is not a letter or a digit has become an
 * underscore, and lib/power-supply.js and lib/power_supply.js would come to
 * the same one. Only the side that did the mangling knows.
 */
function writeCoverageManifest() {
    if (!_coverageDir)
        return;
    GLib.file_set_contents(_coverageDir + "/sources.json",
                           JSON.stringify(_coverageNames, null, 2));
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

/*
 * This case cannot be run here, which is not the same as this case failed.
 *
 * A case that talks to a live daemon has nothing to say on a machine with no
 * system bus, and a build that goes red for that reason teaches everybody to
 * ignore red. The runner counts these separately and says what was skipped
 * and why, so a case that is quietly never running anywhere is visible.
 */
function skip(why) {
    let reason = new Error(why);
    reason.skipped = true;
    throw reason;
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

/*
 * A source file as text, for the cases that check what the code says rather
 * than what it does. applet.js cannot be loaded outside Cinnamon - it imports
 * the shell's own modules at the top - so reading it is the only way to hold
 * it to anything.
 */
function readFile(path) {
    return Loader.read(path);
}

/* ---------------------------------------------------------------- */
/* asynchronous results                                              */

/*
 * Runs a main loop until an asynchronous call has answered, and gives back
 * what it answered with. `start` is handed the callback to pass on.
 *
 * This is what lets a case that exercises an asynchronous read stay an
 * ordinary function that throws, like every other case here. A call that
 * answers before the loop is entered is handled too, since an empty batch of
 * work is allowed to finish immediately, and one that never answers fails
 * after a few seconds rather than hanging the suite.
 */
function settle(start, what) {
    const GLib = imports.gi.GLib;
    let loop = new GLib.MainLoop(null, false);
    let result = null;
    let answered = false;

    start(function (value) {
        result = value;
        answered = true;
        loop.quit();
    });

    if (!answered) {
        let guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, function () {
            guard = 0;
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
        if (guard)
            GLib.source_remove(guard);
    }

    if (!answered)
        fail((what || "the asynchronous call") + " never answered");
    return result;
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
