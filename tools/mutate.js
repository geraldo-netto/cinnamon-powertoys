#!/usr/bin/env cjs
/*
 * Mutation testing: change the code on purpose, and see whether anything
 * notices.
 *
 * Coverage says a line ran. It does not say that running it proved anything,
 * and the two come apart quietly - a case that calls a function and asserts
 * only that it did not throw covers every line in it and holds it to nothing.
 * The way to tell is to break the code and find out whether the suite goes
 * red. A mutant nothing catches is a statement about the tests: either
 * something is unasserted, or that code could say something else and no
 * behaviour anybody cares about would change.
 *
 * Each mutant is one change, run against the whole suite, then put back. The
 * work is done on a copy of the applet in a temporary directory - the runner
 * is pointed at it with POWERTOYS_XLET_DIR - so nothing here can leave a
 * broken source in the working tree, whatever happens to the run.
 *
 * Usage: mutate.js [file ...] [--min N] [--quiet] [--seed N] [--sample N]
 *
 * Files are paths under the applet directory, e.g. lib/ddc.js; with none, all
 * of them. --sample takes that many mutants per file, chosen by a seeded
 * shuffle, for a quick answer on a big file; --min fails the run under that
 * score.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

const TOOLS = scriptDir();
const ROOT = GLib.path_get_dirname(TOOLS);
const UUID = "cinnamon-powertoys@geraldo-netto";

imports.searchPath.unshift(TOOLS);
const Loader = imports.loader;
const Scan = imports.scan;

/* ---------------------------------------------------------------- */
/* what a mutant is                                                  */

/*
 * The changes worth making.
 *
 * Each is a small, plausible mistake rather than damage: a comparison that
 * lets the boundary through, an and that should have been an or, a guard
 * dropped, a step of one that became a step of nothing. They are the mistakes
 * this codebase has actually made - PT-135 was a flag lowered too early,
 * PT-145c a guard that did not cover enough, the alerts clamp an operator that
 * excluded its own boundary - so a suite that cannot tell them from the
 * original is a suite that would not have caught those either.
 *
 * `from` is matched in the masked source, so an operator inside a doc block, a
 * translated string or a regular expression is never a site.
 */
const OPERATORS = [
    { from: "===", to: "!==" },
    { from: "!==", to: "===" },
    { from: ">=", to: ">" },
    { from: "<=", to: "<" },
    { from: "&&", to: "||" },
    { from: "||", to: "&&" },
    { from: "!", to: "" },
    { from: ">", to: ">=" },
    { from: "<", to: "<=" },
    { from: "+", to: "-" },
];

/* Longest first, so that === is never seen as = or as two of anything. */
const SORTED = OPERATORS.slice().sort((a, b) => b.from.length - a.from.length);

/* Characters that would make a match part of a longer operator: `a !== b`
 * must not be read as the `!` site, and `x++` is not the `+` site. */
const GLUE = /[=!<>+\-&|]/;

function _operatorSites(code) {
    let sites = [];

    for (let i = 0; i < code.length; i++) {
        for (let rule of SORTED) {
            if (code.substr(i, rule.from.length) !== rule.from)
                continue;
            let before = code[i - 1] || "";
            let after = code[i + rule.from.length] || "";
            if (GLUE.test(before) || GLUE.test(after))
                break;
            /* `!` before a name is a guard worth dropping; `!` anywhere else
             * has already been matched by a longer rule above. */
            sites.push({ at: i, length: rule.from.length, from: rule.from, to: rule.to });
            break;
        }
    }

    return sites;
}

/*
 * Numbers, which in this codebase are nearly all thresholds and steps: the
 * notch a wheel moves by, how many readings a profile may lapse over, how far
 * clear of a limit a battery has to climb. Each is replaced by something next
 * to it, which is the mistake somebody makes rather than damage.
 */
function _numberSites(code) {
    let sites = [];
    let pattern = /(^|[^\w.$])(\d+)(?![\w.])/g;
    let match;

    while ((match = pattern.exec(code)) !== null) {
        let at = match.index + match[1].length;
        let value = Number(match[2]);
        let to = value === 0 ? "1" : (value === 1 ? "0" : String(value + 1));
        sites.push({ at: at, length: match[2].length, from: match[2], to: to });
        /* Overlapping matches would otherwise be skipped, since the pattern
         * consumes the character in front of the number. */
        pattern.lastIndex = at + match[2].length;
    }

    return sites;
}

/*
 * `return` with nothing after it, so a function that answers stops answering.
 * Everything here that hands a value back is read by somebody.
 *
 * Not where the answer is already null or undefined. Replacing `return null`
 * with `return null` is a mutant nothing can kill, and an unkillable mutant is
 * worse than no mutant: it sits in the survivors asking to be chased, and
 * whoever chases it will find that the only way to make it die is to assert
 * something untrue.
 */
function _returnSites(code) {
    let sites = [];
    let pattern = /\breturn\s+(?!null\s*;|undefined\s*;)(?=[^;\n])/g;
    let match;

    while ((match = pattern.exec(code)) !== null)
        sites.push({ at: match.index, length: 6, from: "return", to: "return null; //" });

    return sites;
}

function mutants(source) {
    let code = Scan.mask(source);
    let found = [].concat(_operatorSites(code), _numberSites(code), _returnSites(code));

    return found.map(site => ({
        line: Scan.lineAt(source, site.at),
        from: site.from,
        to: site.to,
        source: source.slice(0, site.at) + site.to + source.slice(site.at + site.length),
    })).sort((a, b) => a.line - b.line);
}

/* ---------------------------------------------------------------- */
/* running them                                                      */

/* A seeded shuffle, so that --sample takes a different slice on a different
 * seed and the same slice on the same one. Nothing here may read a clock. */
function shuffled(items, seed) {
    let state = seed >>> 0 || 1;
    let out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        state = (state * 1664525 + 1013904223) >>> 0;
        let j = state % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function run(argv, environment) {
    let [, , , status] = GLib.spawn_sync(ROOT, argv, environment,
                                         GLib.SpawnFlags.SEARCH_PATH, null);
    return status;
}

/*
 * The copy to work on, and a short fuse on anything asynchronous.
 *
 * A mutant that breaks a callback does not fail a case, it stops one
 * answering - and the harness waits five seconds before calling that a
 * failure. At one whole suite run per mutant, that is the difference between
 * a run somebody makes and a run somebody means to make one day. One second
 * leaves room for the live install rollback's two applet reloads while the
 * outer timeout still catches a callback that will never arrive; cases that
 * talk to a real daemon keep the generous default in an ordinary run.
 */
function environmentWith(xletDir) {
    return GLib.get_environ()
        .filter(entry => entry.indexOf("POWERTOYS_XLET_DIR=") !== 0 &&
                         entry.indexOf("POWERTOYS_SETTLE_MS=") !== 0)
        .concat(["POWERTOYS_XLET_DIR=" + xletDir, "POWERTOYS_SETTLE_MS=1000"]);
}

function sourceFiles() {
    let names = [];
    for (let name of _listDir(ROOT + "/" + UUID + "/lib"))
        names.push("lib/" + name);
    return names.filter(name => name.substr(-3) === ".js").sort();
}

function _listDir(path) {
    const Gio = imports.gi.Gio;
    let names = [];
    let directory = Gio.File.new_for_path(path);
    if (!directory.query_exists(null))
        return names;
    let entries = directory.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null)
        names.push(info.get_name());
    entries.close(null);
    return names;
}

/* ---------------------------------------------------------------- */

let args = ARGV.slice();
let minimum = 80;
let quiet = false;
let seed = 1;
let sample = 0;
let files = [];

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min")
        minimum = Number(args[++i]);
    else if (args[i] === "--seed")
        seed = Number(args[++i]);
    else if (args[i] === "--sample")
        sample = Number(args[++i]);
    else if (args[i] === "--quiet")
        quiet = true;
    else
        files.push(args[i]);
}

if (files.length === 0)
    files = sourceFiles();

/*
 * The copy everything is done to: the applet, and the suite that runs against
 * it. Made once, and one file in it is rewritten per mutant.
 *
 * The tests are copied as well as the sources so that a run in progress is not
 * reading a case file somebody is in the middle of writing. A mutation run
 * takes minutes, which is long enough for that to happen, and a survivor
 * reported against a half written case is worse than no answer.
 */
let work = GLib.dir_make_tmp("powertoys-mutate-XXXXXX");
let copy = work + "/" + UUID;
/* Tests also inspect these root fixtures. Keep the manifest explicit so the
 * isolated baseline proves the same project that the ordinary suite proves. */
for (let part of [UUID, "tests", "tools", "install.sh", "Makefile", "README.md"]) {
    if (run(["cp", "-r", ROOT + "/" + part, work + "/" + part], null) !== 0) {
        printerr("could not copy " + part + " to " + work);
        System.exit(2);
    }
}

let environment = environmentWith(copy);

/*
 * The suite, under a clock.
 *
 * A mutant does not only make cases fail; it can stop the run finishing at
 * all. A loop that no longer reaches its end, a callback that no longer
 * answers something the harness is waiting on - and there is no answer coming,
 * so a run without a limit waits for ever and takes the mutation run with it.
 *
 * A mutant that hangs the suite is a mutant the suite noticed, so the timeout
 * counts as a kill: it is a failure like any other, and a slower one.
 */
let suite = ["timeout", "--kill-after=2", "10", "cjs", work + "/tests/run.js"];

/* A suite that is not green against the copy says nothing about a mutant. */
if (run(suite, environment) !== 0) {
    printerr("the suite does not pass against an unmutated copy; nothing to learn here");
    run(["rm", "-rf", work], null);
    System.exit(2);
}

let totals = { killed: 0, survived: 0 };
let survivors = [];

for (let file of files) {
    let path = ROOT + "/" + UUID + "/" + file;
    let target = copy + "/" + file;
    let original = Loader.read(path);
    let candidates = mutants(original);

    if (sample > 0 && candidates.length > sample)
        candidates = shuffled(candidates, seed).slice(0, sample).sort((a, b) => a.line - b.line);

    let killed = 0;
    for (let mutant of candidates) {
        GLib.file_set_contents(target, mutant.source);
        let status = run(suite, environment);
        if (status === 0)
            survivors.push({ file: file, mutant: mutant });
        else
            killed++;
    }
    GLib.file_set_contents(target, original);

    totals.killed += killed;
    totals.survived += candidates.length - killed;

    if (!quiet) {
        let score = candidates.length === 0 ? 100
            : Math.round(killed / candidates.length * 1000) / 10;
        print(file + "  " + score + "%  " + killed + " of " + candidates.length + " caught");
    }
}

run(["rm", "-rf", work], null);

let total = totals.killed + totals.survived;
let score = total === 0 ? 100 : Math.round(totals.killed / total * 1000) / 10;

if (survivors.length > 0) {
    printerr("");
    for (let survivor of survivors) {
        printerr("  survived  " + survivor.file + ":" + survivor.mutant.line + "  " +
                 survivor.mutant.from + " -> " +
                 (survivor.mutant.to === "" ? "(dropped)" : survivor.mutant.to));
    }
}

if (score < minimum) {
    printerr("");
    printerr("mutants FAIL " + score + "% caught of " + total + ", under " + minimum + "%");
    System.exit(1);
}

print("mutants ok   " + score + "% of " + total + " caught, " +
      survivors.length + " survived");
