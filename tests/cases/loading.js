/*
 * The libraries load, and offer what the applet reaches for.
 *
 * This is the case that earns the harness: it loads each module exactly as
 * Cinnamon does and checks the names applet.js uses are all there. A rename
 * that a parse check cannot see - the file is still valid JavaScript - shows
 * up here as a missing export.
 */

const Harness = imports.harness;

var cases = {};

const MODULES = ["io", "log", "gettext", "format", "device", "sensors", "cpu",
                 "power-supply", "privileged", "upower", "profiles", "backlight", "ddc",
                 "bluez"];

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

cases["the libraries load without a shell"] = function () {
    /* lib/log.js exists so that nothing in lib/ touches Cinnamon's globals at
     * load time. If something starts to, this is where it shows. */
    Harness.equal(typeof globalThis.global, "undefined",
                  "a library defined a shell global just by being loaded");
};
