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
                 "bluez", "alerts", "reading", "sensor-rows", "panel-text", "pending-profile",
                 "keyed-list", "cinnamon-panel"];

for (let name of MODULES) {
    cases["lib/" + name + ".js loads"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        Harness.ok(module, name + " returned nothing");
    };
}

cases["runtime D-Bus constructors forward lifecycle cancellables"] = function () {
    let expected = { bluez: 1, backlight: 1, profiles: 1, upower: 2 };
    for (let name in expected) {
        let source = Harness.readFile(Harness.xletDir() + "/lib/" + name + ".js");
        let forwards = source.match(/cancellable \|\| null/g) || [];
        Harness.equal(forwards.length, expected[name],
                      name + " forwards every owned cancellable to Gio");
    }
};

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

/*
 * Where a file gets its translator from.
 *
 * lib/sensors.js took `_` off lib/format.js, which works only because the
 * loader re-exports every top level declaration - so format.js was handing on a
 * `const` it never meant to publish, and sensors.js depended on it for a reason
 * that has nothing to do with formatting. The one file that owns the text
 * domain is lib/gettext.js, and asking anything else for it is asking a file
 * that happens to have already asked.
 */
cases["a file that translates asks lib/gettext.js for the translator"] = function () {
    let wrong = [];
    let checked = 0;

    for (let file of sourceFiles()) {
        let source = Harness.readFile(file);
        let match = /(?:const|var|let)\s+_\s*=\s*([A-Za-z_$][\w$]*)\._\s*;/.exec(source);
        if (!match)
            continue;
        checked++;
        if (requiresIn(source)[match[1]] !== "gettext")
            wrong.push(file.replace(Harness.xletDir() + "/", "") + " takes _ from " + match[1]);
    }

    Harness.deepEqual(wrong, [], "second hand translators");
    Harness.ok(checked > 4, "only " + checked + " files checked, which is too few to be right");
};

cases["the libraries load without a shell"] = function () {
    /* lib/log.js exists so that nothing in lib/ touches Cinnamon's globals at
     * load time. If something starts to, this is where it shows. */
    Harness.equal(typeof globalThis.global, "undefined",
                  "a library defined a shell global just by being loaded");
};

cases["partial applet construction owns its rollback"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    let start = source.indexOf("constructor(metadata, orientation");
    let constructor = source.slice(start, source.indexOf("\n    _initialize(metadata", start));
    Harness.ok(constructor.indexOf("try {") >= 0, "initialization has a guarded acquisition stage");
    Harness.ok(constructor.indexOf("this._teardown()") >= 0,
               "a constructor that cannot return releases its partial state");
    Harness.ok(source.indexOf("on_applet_removed_from_panel() {\n        this._teardown();") >= 0,
               "normal removal uses the same teardown path");
};

cases["a late collection stops when its applet is destroyed"] = function () {
    /* applet.js needs Cinnamon's UI modules and cannot be loaded by the
     * shell-free runner. Exercise its collection method with only the two
     * asynchronous backend contracts it uses. */
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    let match = /    _collect\(onDone\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* The sensor readings/.exec(source);
    Harness.ok(match, "the collection method can be isolated");

    let logged = [];
    let collect = Function("Log", "return function (onDone) {" + match[1] + "\n};")({
        error: message => logged.push(message),
    });
    let sensorDone = null;
    let cpuDone = null;
    let assembled = 0;
    let answers = [];
    let applet = {
        _destroyed: false,
        _sensorFilter: () => function () { return true; },
        _sensors: {
            readAsync: (wanted, onDone) => { sensorDone = onDone; },
        },
        _cpu: {
            sample: onDone => { cpuDone = onDone; },
        },
        _assemble: readings => {
            assembled++;
            return readings;
        },
    };

    collect.call(applet, answer => answers.push(answer));
    sensorDone({ temperatures: [] });
    applet._destroyed = true;
    cpuDone(false);

    Harness.equal(assembled, 0, "destroyed backends are not read while assembling");
    Harness.deepEqual(answers, [null], "the abandoned collection still settles exactly once");
    Harness.deepEqual(logged, [], "ordinary teardown is not reported as a collection error");
};

cases["slow rediscovery includes CPU topology"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    let rediscover = /    _rediscover\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(rediscover, "the rediscovery method can be isolated");
    Harness.ok(rediscover[1].indexOf("this._cpu.refresh()") >= 0,
               "the periodic hardware sweep refreshes CPU policies and drivers");

    let opened = /    _onMenuOpened\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(opened, "the menu-open method can be isolated");
    Harness.equal(opened[1].indexOf("this._cpu.refresh()"), -1,
                  "menu opening reuses the shared rediscovery path");
    Harness.ok(opened[1].indexOf('["screen", "keyboard"]') >= 0,
               "only the signal-backed kernel controls are considered for a retry");
    Harness.ok(opened[1].indexOf("!control.available") >= 0,
               "an available D-Bus backlight keeps its cached signal-driven value");
    Harness.equal(opened[1].indexOf("for (let name in this._backlights)"), -1,
                  "external monitors stay on their separate DDC probe lifecycle");
};
