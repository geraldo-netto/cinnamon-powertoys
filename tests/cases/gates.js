/*
 * The gates that read the sources, given the mistake each one exists to catch.
 *
 * `make check` runs three tools over the applet's own JavaScript: the parse
 * check, which says the engine will accept the file; the scope check, which
 * says every name written in it exists; and the strings check, which says
 * every sentence it asks to have translated is in the template. Until this
 * file, all that was ever held about them was that the Makefile still names
 * them. A gate whose pattern stopped matching, whose walk stopped descending
 * or whose exit status stopped being read goes on printing "ok" over
 * anything, and nothing here would have said so - which is exactly the shape
 * of a gate that has quietly stopped being one.
 *
 * So each of them is given a file with its own mistake in it and has to fail,
 * and a clean file and has to pass. What the mistakes are is deliberate: each
 * one is invisible to the other two gates, which is the reason all three
 * exist rather than one.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

function root() {
    return Harness.testsDir() + "/..";
}

/* A file of the given text, and the tool's exit status over it. Everything is
 * written into a temporary directory: a gate under test is a process that
 * reads a path, and the path it reads is never one this repository ships. */
function statusOver(tool, text, before) {
    let directory = GLib.dir_make_tmp("powertoys-gate-XXXXXX");
    try {
        let file = directory + "/subject.js";
        GLib.file_set_contents(file, text);
        let argv = ["cjs", root() + "/tools/" + tool].concat(before || []).concat([file]);
        return Harness.settle(done => Privileged._spawn(argv,
            (status, stderr, stdout) => done({
                status: status, output: (stdout || "") + (stderr || ""),
            })), "the " + tool + " run");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

/* The same, for a tool that is handed several files at once: a name to
 * contents map goes in, and the files are written in the order given so a gate
 * that reads only its first operand can be told apart from one that reads all
 * of them. */
function statusOverAll(tool, files, before) {
    let directory = GLib.dir_make_tmp("powertoys-gate-XXXXXX");
    try {
        let paths = [];
        for (let name in files) {
            GLib.file_set_contents(directory + "/" + name, files[name]);
            paths.push(directory + "/" + name);
        }
        let argv = ["sh", root() + "/tools/" + tool].concat(before || []).concat(paths);
        return Harness.settle(done => Privileged._spawn(argv,
            (status, stderr, stdout) => done({
                status: status, output: (stdout || "") + (stderr || ""),
            })), "the " + tool + " run");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

/* A file every gate is happy with, so a failure below is about the mistake
 * that was added and not about the file it was added to. */
const CLEAN = "const Value = 1;\nfunction use(what) {\n    return what + Value;\n}\n";

/* The shell equivalents. `a.sh` is first on the command line, so a gate that
 * stops after its first operand passes `b.sh` without reading it. */
const CLEAN_SHELL = "#!/bin/sh\necho fine\n";
const BROKEN_SHELL = "#!/bin/sh\nif [ 1 ; then\n";

var cases = {};

cases["the parse check rejects what the engine would reject"] = function () {
    let broken = statusOver("parse-check.js", "function main( {\n");
    Harness.ok(broken.status !== 0,
               "a file the engine cannot parse fails: " + broken.output);
    Harness.ok(broken.output.indexOf("parse FAIL") >= 0,
               "and says which file: " + broken.output);

    let clean = statusOver("parse-check.js", CLEAN);
    Harness.equal(clean.status, 0, "an ordinary file passes: " + clean.output);
};

cases["the scope check rejects a name that resolves to nothing"] = function () {
    /* Valid JavaScript, and the parse check has nothing to say about it: the
     * mistake is that `missing` was never declared, which is a ReferenceError
     * on the line that runs and on no line before it. */
    let broken = statusOver("scope-check.js",
                            "function use() {\n    return missing + 1;\n}\n");
    Harness.ok(broken.status !== 0,
               "an undeclared name fails: " + broken.output);
    Harness.ok(broken.output.indexOf("missing") >= 0,
               "and the name is in the report: " + broken.output);

    let clean = statusOver("scope-check.js", CLEAN);
    Harness.equal(clean.status, 0, "an ordinary file passes: " + clean.output);
};

cases["the strings check rejects a sentence the template does not carry"] = function () {
    let pot = Harness.xletDir() + "/po/" +
              "cinnamon-powertoys@geraldo-netto.pot";
    let broken = statusOver("strings-check.js",
                            'const _ = 1;\nlet asked = _("a sentence no template carries");\n',
                            [pot]);
    Harness.ok(broken.status !== 0,
               "an untranslated sentence fails: " + broken.output);
    Harness.ok(broken.output.indexOf("make pot") >= 0,
               "and says what to do about it: " + broken.output);

    /* A sentence the template does carry, so what is proved is that the
     * lookup answers both ways rather than that it always refuses. */
    let clean = statusOver("strings-check.js",
                           'const _ = 1;\nlet asked = _("Balanced");\n', [pot]);
    Harness.equal(clean.status, 0,
                  "a sentence in the template passes: " + clean.output);
};

/*
 * The one that had stopped being a gate.
 *
 * `sh -n a.sh b.sh` parses a.sh and hands b.sh to it as $1, so the Makefile
 * line that read "shell ok     helper and install scripts" had only ever
 * parsed the helper. What is held here is the property that mistake broke:
 * a bad script anywhere in the list fails, not only a bad first one.
 */
cases["the shell syntax check reads every script, not the first"] = function () {
    let broken = statusOverAll("shell-syntax.sh",
                               { "a.sh": CLEAN_SHELL, "b.sh": BROKEN_SHELL });
    Harness.ok(broken.status !== 0,
               "a script after the first one still fails: " + broken.output);

    let first = statusOverAll("shell-syntax.sh",
                              { "a.sh": BROKEN_SHELL, "b.sh": CLEAN_SHELL });
    Harness.ok(first.status !== 0,
               "and so does a bad first one: " + first.output);

    let clean = statusOverAll("shell-syntax.sh",
                              { "a.sh": CLEAN_SHELL, "b.sh": CLEAN_SHELL });
    Harness.equal(clean.status, 0, "two ordinary scripts pass: " + clean.output);
    Harness.ok(clean.output.indexOf("2 scripts") >= 0,
               "and it says how many it read: " + clean.output);
};
