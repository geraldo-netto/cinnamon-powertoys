#!/usr/bin/env cjs
/*
 * Loads the applet's shell code the way Cinnamon loads it, and says whether
 * it loaded.
 *
 * applet.js and the four modules under ui/ are a third of this applet and the
 * only third nothing evaluates: the tests load lib/, the coverage run
 * measures lib/, and everything held about the rest is held by reading it as
 * text. What that leaves uncovered is the whole class of mistake that is
 * neither a syntax error nor an unresolved name - a require of a file that
 * moved, a class extending an export that is no longer there, a top level
 * constant read off a library under its old name. Every one of those is a
 * module that throws the moment Cinnamon evaluates it, which is on a user's
 * panel and nowhere else.
 *
 * There is no stand-in shell here and there is deliberately none: a stub of
 * imports.ui.popupMenu proves the module loads against the stub. What this
 * does instead is put the real Cinnamon on the import path - see
 * tools/shell-load.sh for the paths - and evaluate the real files through
 * tools/loader.js, which is the same emulation the parse check and the
 * harness use. So a module that loads here is a module the shell can load.
 *
 * What is not real is `global`. That object is installed by the C side of a
 * running Cinnamon and there is no session here to install it, so the two
 * fields the shell's own modules read while they are being loaded are stood
 * in for and everything else answers as an inert stub. Nothing of the applet
 * touches it; it exists so that Cinnamon's modules get through their own top
 * level.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

/*
 * Cinnamon pins these before it loads a line of JavaScript, and muffin ships
 * two versions of each. Left unpinned, the first module to ask gets version
 * 1.0 and the next one asks for 0 and fails - which is a fact about this
 * loader, not about the applet, so it is settled here before anything else
 * imports.
 */
imports.gi.versions.Clutter = "0";
imports.gi.versions.Cogl = "0";
imports.gi.versions.CoglPango = "0";
imports.gi.versions.Meta = "0";

function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

imports.searchPath.unshift(scriptDir());
const Loader = imports.loader;

const XLET_DIR = ARGV[0];
const CINNAMON_JS = ARGV[1];

if (!XLET_DIR || !CINNAMON_JS) {
    printerr("usage: shell-load.js XLET_DIR CINNAMON_JS_DIR");
    System.exit(2);
}

/*
 * Anything asked of `global` that is not one of the fields below. It answers
 * to a property, a call and a construction, so a shell module that reaches
 * through it while loading gets something rather than a ReferenceError - and
 * gets nothing that could be mistaken for a working session.
 */
function inert(name) {
    return new Proxy(function () {}, {
        get: function (target, key) {
            if (typeof key !== "string" || key === "then")
                return undefined;
            if (key === "toString")
                return () => "[unavailable " + name + "]";
            return inert(name + "." + key);
        },
        set: function () {
            return true;
        },
        apply: function () {
            return inert(name + "()");
        },
        construct: function () {
            return inert("new " + name);
        },
    });
}

/*
 * The fields Cinnamon's own modules read at load time, answered for real
 * because they are used for real: ui/extension.js builds the per-type user
 * directories under `userdatadir` and creates them on disk. It is given a
 * temporary directory, so a run of this leaves nothing behind in the one a
 * session would use.
 */
function shellStandIn(dataDir) {
    let fields = { userdatadir: dataDir, datadir: CINNAMON_JS + "/.." };
    return new Proxy(fields, {
        get: function (target, key) {
            if (typeof key !== "string")
                return undefined;
            return key in target ? target[key] : inert("global." + key);
        },
        set: function (target, key, value) {
            target[key] = value;
            return true;
        },
    });
}

/*
 * The same resolution and the same module body as tests/harness.js, for the
 * same reason: a file loaded any other way is not the file Cinnamon loads.
 */
let cache = {};

function requireXlet(path) {
    if (path.substr(-3) !== ".js")
        path += ".js";
    if (path[0] === "." || path[0] !== "/")
        path = XLET_DIR + "/" + path.replace(/\.\//g, "");
    if (cache[path])
        return cache[path];

    let exports = {};
    let module = { exports: exports };
    let meta = { uuid: GLib.path_get_basename(XLET_DIR), path: XLET_DIR };
    cache[path] = Loader.compile(Loader.moduleBody(Loader.read(path)))
        .call(exports, requireXlet, exports, module, meta, XLET_DIR, path);
    return cache[path];
}

function widgetModules() {
    const Gio = imports.gi.Gio;
    let names = [];
    let directory = Gio.File.new_for_path(XLET_DIR + "/ui");
    if (!directory.query_exists(null))
        return names;
    let entries = directory.enumerate_children("standard::name",
                                               Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null) {
        let name = info.get_name();
        if (name.substr(-3) === ".js")
            names.push("./ui/" + name);
    }
    entries.close(null);
    return names.sort();
}

function remove(directory) {
    GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                    GLib.SpawnFlags.SEARCH_PATH, null);
}

let dataDir = GLib.dir_make_tmp("powertoys-shell-load-XXXXXX");
globalThis.global = shellStandIn(dataDir);

let failures = [];
let loaded = 0;

try {
    imports.searchPath.unshift(CINNAMON_JS);

    /*
     * Cinnamon loads ui/main.js before any applet, and the shell's own
     * modules are circular around it: popupMenu.js reaches ui/panel.js, which
     * reads back out of popupMenu.js before popupMenu.js has finished. In a
     * session that resolves because main.js got there first. Asking for it
     * here puts the modules in the same order, and asking for it at all is
     * the first thing that would fail if this machine's Cinnamon were not
     * loadable - which is a skip, not an applet failure.
     */
    let shellMain = imports.ui.main;
    if (!shellMain) {
        print("shell skip   Cinnamon's own modules did not load");
        remove(dataDir);
        System.exit(2);
    }

    for (let name of widgetModules().concat(["./applet.js"])) {
        try {
            let module = requireXlet(name);
            if (!module)
                throw new Error("loaded but exported nothing");
            loaded++;
        } catch (error) {
            failures.push(name + ": " + error + "\n        " +
                          String(error && error.stack).split("\n").slice(0, 4).join("\n        "));
        }
    }

    /*
     * The one name the shell itself calls. A module that loads and does not
     * offer this is an applet Cinnamon cannot start, which is the same
     * failure a load error is and is invisible to everything that reads the
     * file as text.
     */
    if (failures.length === 0 && typeof cache[XLET_DIR + "/applet.js"].main !== "function")
        failures.push("applet.js: main() is not exported for Cinnamon to call");
} finally {
    remove(dataDir);
}

if (failures.length > 0) {
    printerr("");
    for (let failure of failures)
        printerr("  " + failure);
    printerr("shell FAIL   " + failures.length + " of " + (loaded + failures.length) +
             " shell sources did not load");
    System.exit(1);
}

print("shell ok     " + loaded + " sources loaded in a real Cinnamon");
System.exit(0);
