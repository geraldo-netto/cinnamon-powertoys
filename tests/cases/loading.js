/*
 * The libraries load, and offer what the applet reaches for.
 *
 * This is the case that earns the harness: it loads each module exactly as
 * Cinnamon does and checks the names applet.js uses are all there. A rename
 * that a parse check cannot see - the file is still valid JavaScript - shows
 * up here as a missing export.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;
const Loader = imports.loader;

/* The file tools/loader.js claims to copy. Absent on anything that is not a
 * Cinnamon desktop, which includes the runner. */
const FILE_UTILS = "/usr/share/cinnamon/js/misc/fileUtils.js";

var cases = {};

const MODULES = ["io", "log", "gettext", "format", "device", "hardware", "sensors", "cpu",
                 "power-supply", "privileged", "upower", "profiles", "backlight", "ddc",
                 "bluez", "alerts"];

for (let name of MODULES) {
    cases["lib/" + name + ".js loads"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        Harness.ok(module, name + " returned nothing");
    };
}

/*
 * Every name any source file reaches for on a library, found by reading the
 * sources rather than by keeping a list.
 *
 * A list was kept here, and it drifted exactly where the newest code was:
 * three names the applet had started using were absent, one it had stopped
 * using was still there, and what one library used from another was outside
 * its scope entirely. A list of what the code does, maintained by hand
 * alongside the code, is a second place to forget.
 *
 * So the requires are read out of each file, and every `Alias.symbol` on one
 * of them has to resolve. A rename that a parse check cannot see - the file
 * is still valid JavaScript - fails here, whichever file did the renaming and
 * whichever did the using.
 */
function sourceFiles() {
    let files = [Harness.xletDir() + "/applet.js"];
    for (let name of MODULES)
        files.push(Harness.xletDir() + "/lib/" + name + ".js");
    return files;
}

/* `const Sensors = require("./lib/sensors.js")` - the alias and what it is. */
function requiresIn(source) {
    let aliases = {};
    let pattern = /(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\("\.\/lib\/([\w-]+)\.js"\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null)
        aliases[match[1]] = match[2];
    return aliases;
}

function usedNames(source, alias) {
    let names = {};
    let pattern = new RegExp("\\b" + alias + "\\.([A-Za-z_$][\\w$]*)", "g");
    let match;
    while ((match = pattern.exec(source)) !== null)
        names[match[1]] = true;
    return Object.keys(names).sort();
}

cases["every name a source reaches for on a library is exported"] = function () {
    let missing = [];
    let checked = 0;

    for (let file of sourceFiles()) {
        let source = Harness.readFile(file);
        let aliases = requiresIn(source);
        for (let alias in aliases) {
            let module = Harness.requireXlet("./lib/" + aliases[alias] + ".js");
            for (let symbol of usedNames(source, alias)) {
                checked++;
                if (module[symbol] === undefined || module[symbol] === null)
                    missing.push(file.replace(Harness.xletDir() + "/", "") +
                                 " uses " + aliases[alias] + "." + symbol);
            }
        }
    }

    Harness.deepEqual(missing, [], "named and not exported");
    /* If this ever reads zero the regexes have stopped matching and the case
     * is passing by finding nothing at all. */
    Harness.ok(checked > 60, "only " + checked + " names checked, which is too few to be right");
};

/*
 * The one thing in this repository that is a copy of somebody else's file.
 *
 * tools/loader.js exists so the parse check and the harness agree with what
 * Cinnamon actually evaluates, and a copy is a thing that drifts: the list had
 * been tidied into lower case and grown a "cationative" that is in no version
 * of the original. Nothing failed for it, which is the trouble - a difference
 * here shows up as a construct that passes every check and behaves differently
 * in the shell.
 *
 * Skipped where there is no Cinnamon to read, which is the runner. That means
 * this is a check somebody's desktop makes and CI cannot, so it is named in
 * the skip list rather than passing quietly.
 */
cases["the loader emulation's import names are Cinnamon's own"] = function () {
    if (!GLib.file_test(FILE_UTILS, GLib.FileTest.EXISTS))
        Harness.skip("no Cinnamon here to copy from");

    let source = Harness.readFile(FILE_UTILS);
    let match = /var importNames = \[([^\]]*)\]/.exec(source);
    Harness.ok(match, "importNames has moved in " + FILE_UTILS);

    let theirs = match[1].split(",")
        .map(entry => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(entry => entry !== "");
    Harness.deepEqual(Loader.IMPORT_NAMES, theirs,
                      "copy it verbatim, capitals and all - see the note on the list");
};

cases["the libraries load without a shell"] = function () {
    /* lib/log.js exists so that nothing in lib/ touches Cinnamon's globals at
     * load time. If something starts to, this is where it shows. */
    Harness.equal(typeof globalThis.global, "undefined",
                  "a library defined a shell global just by being loaded");
};
