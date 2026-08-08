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
 *        cjs tests/run.js --fail-fast --prioritize ddc,hardware
 *
 * --prioritize changes case-file order without filtering anything.
 * --fail-fast stops at the first real failure. Together they let mutation
 * testing try the cases nearest to a changed library first while retaining
 * the whole suite as the proof that a survivor really survived.
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
const MutationPlan = imports.mutation_plan;
Harness.setRoot(ROOT);

/*
 * A coverage run says where to put the copies it measures, and they have to be
 * on the import path before the first library is loaded. See the harness, and
 * tools/coverage-report.js for what is done with the result.
 */
let coverage = GLib.getenv("POWERTOYS_COVERAGE_DIR");
if (coverage) {
    GLib.mkdir_with_parents(coverage, 0o755);
    imports.searchPath.unshift(coverage);
    Harness.setCoverageDir(coverage);
}

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

let filters = [];
let priorities = [];
let failFast = false;

for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === "--fail-fast") {
        failFast = true;
    } else if (ARGV[i] === "--prioritize") {
        if (i + 1 >= ARGV.length) {
            printerr("--prioritize needs a comma-separated case-file list");
            System.exit(2);
        }
        priorities = priorities.concat(ARGV[++i].split(",").filter(name => name !== ""));
    } else {
        filters.push(ARGV[i]);
    }
}

let passed = 0;
let failed = 0;
let skipped = [];
let failures = [];

caseLoop:
for (let file of MutationPlan.prioritize(caseFiles(), priorities)) {
    let module;
    try {
        module = imports.cases[file];
    } catch (error) {
        failed++;
        failures.push(file + ": will not load: " + error);
        if (failFast)
            break;
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
            /* A case that says it cannot run here is not a case that failed. */
            if (error && error.skipped) {
                skipped.push(label + " - " + error.message);
                print("  skip  " + label);
                continue;
            }
            failed++;
            failures.push(label + "\n        " + error.message);
            print("  FAIL  " + label);
            if (failFast)
                break caseLoop;
        }
    }
}

if (failures.length > 0) {
    printerr("");
    for (let failure of failures)
        printerr("  " + failure);
}

/* Named rather than counted, so a case that has quietly stopped running
 * everywhere is something you can see rather than something you can miss. */
if (skipped.length > 0) {
    print("");
    for (let reason of skipped)
        print("  skipped: " + reason);
}

Harness.writeCoverageManifest();

print("tests ok     " + passed + " passed" +
      (skipped.length > 0 ? ", " + skipped.length + " skipped" : "") +
      (failed > 0 ? ", " + failed + " failed" : ""));
System.exit(failed > 0 ? 1 : 0);
