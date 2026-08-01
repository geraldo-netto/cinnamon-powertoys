#!/usr/bin/env cjs
/*
 * Syntax checks the files given on the command line without running them.
 *
 * The applet sources cannot simply be executed outside Cinnamon: applet.js
 * reads imports.ui.appletManager at load time and dies. Handing the source to
 * new Function() parses it with the same engine Cinnamon uses and reports the
 * error with a line number, without evaluating a single statement.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

function decode(bytes) {
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

if (ARGV.length === 0) {
    printerr("usage: parse-check.js <file>...");
    System.exit(2);
}

let failures = 0;

for (let path of ARGV) {
    let ok = false;
    let bytes = null;

    try {
        [ok, bytes] = GLib.file_get_contents(path);
    } catch (error) {
        printerr("unreadable  " + path + ": " + error);
        failures++;
        continue;
    }

    if (!ok) {
        printerr("unreadable  " + path);
        failures++;
        continue;
    }

    try {
        new Function(decode(bytes));
        print("parse ok    " + path);
    } catch (error) {
        printerr("parse FAIL  " + path + ": " + error);
        failures++;
    }
}

System.exit(failures > 0 ? 1 : 0);
