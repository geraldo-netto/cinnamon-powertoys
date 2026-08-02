#!/usr/bin/env cjs
/*
 * Syntax checks the files given on the command line without running them.
 *
 * The applet sources cannot simply be executed outside Cinnamon: they call
 * require() and reach for the session bus at load time. Handing the source to
 * the loader emulation parses it with the same engine Cinnamon uses, under the
 * same parameter names and the same strict prefix, and reports the error with
 * a line number without evaluating a single statement.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

/* This script's own directory, which is where the loader emulation is. */
function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

imports.searchPath.unshift(scriptDir());
const Loader = imports.loader;

if (ARGV.length === 0) {
    printerr("usage: parse-check.js <file>...");
    System.exit(2);
}

let failures = 0;

for (let path of ARGV) {
    let source;

    try {
        source = Loader.read(path);
    } catch (error) {
        printerr("unreadable  " + path + ": " + error.message);
        failures++;
        continue;
    }

    try {
        Loader.compile(Loader.PREAMBLE + source);
        print("parse ok    " + path);
    } catch (error) {
        printerr("parse FAIL  " + path + ": " + error);
        failures++;
    }
}

System.exit(failures > 0 ? 1 : 0);
