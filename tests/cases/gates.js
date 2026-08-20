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

/* A file every gate is happy with, so a failure below is about the mistake
 * that was added and not about the file it was added to. */
const CLEAN = "const Value = 1;\nfunction use(what) {\n    return what + Value;\n}\n";

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
