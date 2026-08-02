#!/usr/bin/env cjs
/*
 * Runs every case file in tests/cases.
 *
 * A case file exports one object called `cases`, keyed by what the case
 * claims, whose values are functions that throw when the claim is false.
 * There is nothing else to learn: no registration, no ordering, no setup
 * hooks. A file that needs state builds it inside the case.
 *
 * Usage: cjs tests/run.js [name ...]   - names filter by substring.
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const System = imports.system;

/* The runner is the only thing that knows where it was started from. */
function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

const TESTS = scriptDir();
const ROOT = GLib.path_get_dirname(TESTS);

/* tools/ carries the loader emulation the harness loads libraries with. */
imports.searchPath.unshift(ROOT + "/tools");
imports.searchPath.unshift(TESTS);
const Harness = imports.harness;
Harness.setRoot(ROOT);

function caseFiles() {
    let names = [];
    let directory = Gio.File.new_for_path(TESTS + "/cases");
    if (!directory.query_exists(null))
        return names;
    let entries = directory.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null) {
        let name = info.get_name();
        if (name.substr(-3) === ".js")
            names.push(name.slice(0, -3));
    }
    entries.close(null);
    return names.sort();
}

let filters = ARGV;
let passed = 0;
let failed = 0;
let failures = [];

for (let file of caseFiles()) {
    let module;
    try {
        module = imports.cases[file];
    } catch (error) {
        failed++;
        failures.push(file + ": will not load: " + error);
        continue;
    }

    let cases = module.cases || {};
    for (let name in cases) {
        let label = file + ": " + name;
        if (filters.length > 0 && !filters.some(filter => label.indexOf(filter) >= 0))
            continue;
        try {
            cases[name]();
            passed++;
            print("  ok    " + label);
        } catch (error) {
            failed++;
            failures.push(label + "\n        " + error.message);
            print("  FAIL  " + label);
        }
    }
}

if (failures.length > 0) {
    printerr("");
    for (let failure of failures)
        printerr("  " + failure);
}

print("tests ok     " + passed + " passed" + (failed > 0 ? ", " + failed + " failed" : ""));
System.exit(failed > 0 ? 1 : 0);
