#!/usr/bin/env cjs
/*
 * Per function coverage, from what cjs measured of a test run.
 *
 * cjs writes lcov: which lines exist, how many times each was run, and where
 * every function starts. What it does not say is where a function ends, so
 * "this function is 80% covered" cannot be read straight out of it - and a
 * whole-file percentage is the one number that hides exactly what matters,
 * because a file of small well covered functions carries an untouched one
 * without the total moving much.
 *
 * So this works out each function's extent from the source itself, attributes
 * every executable line to the innermost function containing it, and reports
 * one figure per function. The gate is per function too: the run fails naming
 * the functions under the minimum, not the files.
 *
 * Usage: coverage-report.js <coverage-dir> [--min N] [--quiet]
 *
 * The directory is the one the run wrote its lcov and its sources.json to.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

imports.searchPath.unshift(scriptDir());
const Loader = imports.loader;
const Scan = imports.scan;
const Sources = imports.sources;

/*
 * What a function covers, given where it starts.
 *
 * The brace that opens the body is the first one at or after the declaration,
 * and its match is where the function ends. An arrow function with no body
 * braces - `entry => entry.key` - has no brace of its own and would otherwise
 * swallow whichever block follows it, so a brace further off than the line
 * after the declaration is taken as somebody else's and the function is left
 * standing for its own line alone.
 */
function extent(closes, start) {
    for (let line = start; line <= start + 1; line++) {
        if (closes[line])
            return { start: start, end: closes[line][0] };
    }
    return { start: start, end: start };
}

/* ---------------------------------------------------------------- */
/* the measurement                                                   */

/* One record per measured file: its functions, and how often each line ran. */
function parseLcov(text) {
    let files = [];
    let current = null;

    for (let line of text.split("\n")) {
        let colon = line.indexOf(":");
        let tag = colon < 0 ? line : line.slice(0, colon);
        let rest = colon < 0 ? "" : line.slice(colon + 1);

        if (tag === "SF") {
            current = { path: rest, functions: [], hits: {}, branches: {} };
            files.push(current);
        } else if (!current) {
            continue;
        } else if (tag === "FN") {
            let [at, ...name] = rest.split(",");
            current.functions.push({ line: Number(at), name: name.join(",") });
        } else if (tag === "DA") {
            let [at, count] = rest.split(",");
            current.hits[Number(at)] = Number(count);
        } else if (tag === "BRDA") {
            let [at, , , taken] = rest.split(",");
            let key = Number(at);
            current.branches[key] = current.branches[key] || [];
            current.branches[key].push(taken === "-" ? 0 : Number(taken));
        }
    }

    return files;
}

/*
 * Every executable line, given to the innermost function that contains it.
 *
 * Innermost, because a callback is its own function: the lines inside a
 * monitor's reply belong to the reply and not to the call that sent it, and
 * counting them for both would say a function is covered because something
 * inside it was.
 */
function attribute(functions, hits) {
    let ordered = functions.slice().sort((a, b) => (a.end - a.start) - (b.end - b.start));
    let owner = {};

    for (let at in hits) {
        let line = Number(at);
        for (let entry of ordered) {
            if (line >= entry.start && line <= entry.end) {
                owner[line] = entry;
                break;
            }
        }
    }

    for (let entry of functions) {
        entry.lines = 0;
        entry.covered = 0;
    }

    for (let at in owner) {
        let entry = owner[at];
        entry.lines++;
        if (hits[at] > 0)
            entry.covered++;
    }

    return functions;
}

function percentage(covered, total) {
    return total === 0 ? 100 : Math.round(covered / total * 1000) / 10;
}

/* ---------------------------------------------------------------- */
/* what was not measured                                             */

/*
 * The applet's source no case can load, named rather than omitted. Why a
 * report has to say so, and the rule itself, are in tools/sources.js; what is
 * here is the listing that rule needs.
 */
function jsFilesIn(directory, prefix) {
    const Gio = imports.gi.Gio;
    let names = [];
    let folder = Gio.File.new_for_path(directory);
    if (!folder.query_exists(null))
        return names;
    let entries = folder.enumerate_children("standard::name",
                                            Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null) {
        let name = info.get_name();
        if (name.slice(-3) === ".js")
            names.push(prefix + name);
    }
    entries.close(null);
    return names.sort();
}

/*
 * Where the applet is, worked out from a measured source rather than passed
 * in: every entry in the manifest is <xlet>/lib/<name>.js, so the xlet is two
 * directories above any of them. A second copy of that path would be a second
 * thing to move.
 */
function xletDirFrom(sources) {
    for (let name in sources)
        return GLib.path_get_dirname(GLib.path_get_dirname(sources[name]));
    return null;
}

function unmeasuredFiles(sources) {
    let xlet = xletDirFrom(sources);
    if (!xlet)
        return [];
    let measured = {};
    for (let name in sources)
        measured[sources[name]] = true;

    let all = [];
    let reached = [];
    for (let relative of jsFilesIn(xlet, "").concat(jsFilesIn(xlet + "/lib", "lib/"))
                                            .concat(jsFilesIn(xlet + "/ui", "ui/"))) {
        let path = xlet + "/" + relative;
        let source;
        try {
            source = Loader.read(path);
        } catch (error) {
            continue;
        }
        all.push({ name: relative, lines: source.split("\n").length });
        if (measured[path])
            reached.push(relative);
    }
    return Sources.unreached(all, reached);
}

/* ---------------------------------------------------------------- */

let args = ARGV.slice();
let minimum = 80;
let quiet = false;
let directory = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min")
        minimum = Number(args[++i]);
    else if (args[i] === "--quiet")
        quiet = true;
    else
        directory = args[i];
}

if (!directory) {
    printerr("usage: coverage-report.js <coverage-dir> [--min N] [--quiet]");
    System.exit(2);
}

/* The manifest is written by the run, beside the copies it measured; cjs
 * writes its lcov one level up, at the output directory it was given. */
function readManifest() {
    for (let path of [directory + "/modules/sources.json", directory + "/sources.json"]) {
        try {
            return JSON.parse(Loader.read(path));
        } catch (error) {
            /* the other one, then */
        }
    }
    throw new Error("no sources.json; was the run made with POWERTOYS_COVERAGE_DIR set");
}

let lcov;
let sources;
try {
    lcov = parseLcov(Loader.read(directory + "/coverage.lcov"));
    sources = readManifest();
} catch (error) {
    printerr("no coverage in " + directory + ": " + error.message);
    System.exit(2);
}

/* The measured copies are named after the module they stood in for; the
 * manifest says which source that was. */
let byName = {};
for (let name in sources)
    byName[name] = sources[name];

let below = [];
let reports = [];

for (let file of lcov) {
    let name = GLib.path_get_basename(file.path).replace(/\.js$/, "");
    let source = byName[name];
    if (!source)
        continue;

    let closes = Scan.blocks(Loader.read(source));

    /* The module body itself is not a function anybody wrote; its "coverage"
     * is whether the file was loaded, which the loading case already says. */
    let functions = file.functions
        .filter(entry => entry.name !== "top-level" && entry.name !== "__xlet")
        .map(entry => Object.assign(extent(closes, entry.line), { name: entry.name }));

    attribute(functions, file.hits);

    let totals = { lines: 0, covered: 0 };
    for (let at in file.hits) {
        totals.lines++;
        if (file.hits[at] > 0)
            totals.covered++;
    }

    let short = source.slice(source.lastIndexOf("/", source.lastIndexOf("/") - 1) + 1);
    reports.push({ source: short, functions: functions, totals: totals });

    for (let entry of functions) {
        if (percentage(entry.covered, entry.lines) < minimum)
            below.push({ source: short, entry: entry });
    }
}

reports.sort((a, b) => (a.source < b.source ? -1 : 1));

if (!quiet) {
    for (let report of reports) {
        print(report.source + "  " +
              percentage(report.totals.covered, report.totals.lines) + "% of " +
              report.totals.lines + " lines, " + report.functions.length + " functions");
        for (let entry of report.functions.slice().sort((a, b) => a.start - b.start)) {
            let share = percentage(entry.covered, entry.lines);
            print("    " + (share < minimum ? "under " : "      ") +
                  String(share).padStart(5) + "%  " +
                  String(entry.start).padStart(4) + "  " + entry.name +
                  " (" + entry.covered + "/" + entry.lines + ")");
        }
    }
    print("");
}

let functions = reports.reduce((total, report) => total + report.functions.length, 0);
let lines = reports.reduce((total, report) => total + report.totals.lines, 0);
let covered = reports.reduce((total, report) => total + report.totals.covered, 0);

let missing = unmeasuredFiles(sources);
let missingLines = Sources.totalLines(missing);

if (!quiet && missing.length > 0) {
    print("not measured  " + missing.length + " files, " + missingLines +
          " lines: they build Cinnamon widgets and cannot be loaded here");
    for (let entry of Sources.lines(missing))
        print("            " + entry);
    print("");
}

if (below.length > 0) {
    printerr("coverage FAIL " + below.length + " of " + functions +
             " functions under " + minimum + "%");
    for (let miss of below) {
        printerr("  " + miss.source + ":" + miss.entry.start + " " + miss.entry.name +
                 " " + percentage(miss.entry.covered, miss.entry.lines) + "%" +
                 " (" + miss.entry.covered + "/" + miss.entry.lines + ")");
    }
    System.exit(1);
}

print("coverage ok  " + functions + " functions, every one at " + minimum +
      "% or better; " + percentage(covered, lines) + "% of " + lines +
      " measured lines" +
      (missing.length === 0 ? " overall"
          : ", which is " + Sources.share(lines, missingLines) +
            "% of the applet; " + missingLines + " unmeasured lines listed above"));
