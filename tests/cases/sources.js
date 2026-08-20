/*
 * The boundary both gates have to state.
 *
 * `make coverage` measures only what a case loaded and `make mutants` only
 * enumerates lib/, because applet.js and the modules under ui/ build Cinnamon
 * widgets and neither run can load them - tools/shell-load.sh can, in a
 * process of its own, but loading is not measuring. That is a real limit
 * and tools/sources.js does not move it - what it does is stop either report
 * reading as though it had covered the whole applet.
 *
 * The rule is exercised here rather than only through the tools, because one
 * of those tools is `make mutants`, which this suite never runs.
 */

const Harness = imports.harness;
const Sources = imports.sources;

var cases = {};

function entries(pairs) {
    return pairs.map(pair => ({ name: pair[0], lines: pair[1] }));
}

cases["what a run did not reach is what it did not work on"] = function () {
    let all = entries([["lib/io.js", 536], ["applet.js", 2085], ["ui/menu.js", 808]]);
    Harness.deepEqual(Sources.unreached(all, ["lib/io.js"]),
                      entries([["applet.js", 2085], ["ui/menu.js", 808]]),
                      "the enumerated file is dropped and the rest remain");
    Harness.deepEqual(Sources.unreached(all, ["lib/io.js", "applet.js", "ui/menu.js"]), [],
                      "a run that reached everything has nothing to declare");
    Harness.deepEqual(Sources.unreached([], ["lib/io.js"]), [],
                      "nothing to list is not an error");
};

cases["the unreached list is ordered so two reports agree"] = function () {
    /* The two tools print this list beside their own figures. The same set in
     * two orders reads as two different sets, so the order is fixed here and
     * not left to whichever directory listing happened to produce it. */
    let all = entries([["ui/rows.js", 199], ["applet.js", 2085], ["ui/controls.js", 530]]);
    Harness.deepEqual(Sources.unreached(all, []).map(entry => entry.name),
                      ["applet.js", "ui/controls.js", "ui/rows.js"],
                      "by name, whatever order they arrived in");
};

cases["a name reached but never listed changes nothing"] = function () {
    /* The mutation runner is given file names and lists the directory itself,
     * so the two can disagree - a file mutated from an argument that is no
     * longer on disk. That must not remove some other file from the report. */
    let all = entries([["applet.js", 2085]]);
    Harness.deepEqual(Sources.unreached(all, ["lib/gone.js"]), all,
                      "an unknown reached name is ignored");
};

cases["the sizes add up and the share is of the whole applet"] = function () {
    Harness.equal(Sources.totalLines(entries([["a.js", 10], ["b.js", 5]])), 15,
                  "the lines of what was missed");
    Harness.equal(Sources.totalLines([]), 0, "and nothing missed is nothing");
    Harness.equal(Sources.totalLines([{ name: "a.js" }]), 0,
                  "a file with no size counts as none rather than as NaN");

    Harness.equal(Sources.share(6336, 3623), 63.6,
                  "the measured lines as a share of measured plus unmeasured");
    Harness.equal(Sources.share(10, 0), 100, "nothing unreached is the whole of it");
    Harness.equal(Sources.share(0, 0), 100,
                  "an empty applet is not a division by zero");
};

cases["only the shell sources may be unreached"] = function () {
    /* The listing carries a reason, and the reason is true of two kinds of
     * file. Anything else in it is a library nothing executes wearing that
     * reason as a disguise. */
    let missed = entries([["applet.js", 1673], ["ui/menu.js", 576],
                          ["lib/io.js", 588]]);
    Harness.deepEqual(Sources.unexpected(missed).map(entry => entry.name),
                      ["lib/io.js"],
                      "the library is the one that has to be explained");
    Harness.deepEqual(Sources.unexpected(entries([["applet.js", 1673],
                                                  ["ui/rows.js", 242]])), [],
                      "the shell sources are the whole of what the caption covers");
    Harness.deepEqual(Sources.unexpected([]), [], "nothing unreached is nothing to explain");
    Harness.deepEqual(
        Sources.unexpected(entries([["lib/sub/hidden.js", 4]])).map(entry => entry.name),
        ["lib/sub/hidden.js"],
        "a file a directory further down is not exempt for being hard to find");
};

cases["each unreached file is one aligned line naming its size"] = function () {
    Harness.deepEqual(Sources.lines(entries([["ui/menu.js", 808], ["applet.js", 2085]])),
                      ["  2085  applet.js", "   808  ui/menu.js"],
                      "sorted, right aligned, size then name");
    Harness.deepEqual(Sources.lines([]), [], "nothing missed prints nothing");
};

/*
 * The reason this file exists: the two tools have to ask, or the boundary is
 * back to being invisible. Read from the sources, because `make mutants` is
 * the maintainer's to run and this suite never executes it.
 */
cases["both gates ask what they did not reach"] = function () {
    for (let tool of ["coverage-report.js", "mutate.js"]) {
        let source = Harness.readFile(Harness.ROOT + "/tools/" + tool);
        Harness.ok(source.indexOf("imports.sources") >= 0,
                   tool + " loads the shared rule");
        Harness.ok(source.indexOf("Sources.unreached(") >= 0,
                   tool + " asks what it did not reach");
        Harness.ok(source.indexOf("Sources.totalLines(") >= 0,
                   tool + " reports how much that was");
    }

    /* And the coverage run does something about it rather than only printing
     * it: an unreached library is a failure there, not a footnote. */
    let coverage = Harness.readFile(Harness.ROOT + "/tools/coverage-report.js");
    Harness.ok(coverage.indexOf("Sources.unexpected(") >= 0,
               "coverage-report.js checks the caption it prints");
};

cases["neither report can claim to be about the whole applet"] = function () {
    /* The closing line is the one most people read. It has to carry the
     * qualification, not only the listing above it. */
    let coverage = Harness.readFile(Harness.ROOT + "/tools/coverage-report.js");
    Harness.ok(coverage.indexOf("measured lines") >= 0,
               "the coverage figure says the lines it is of are the measured ones");
    Harness.ok(coverage.indexOf("% of the applet") >= 0,
               "and what share of the applet that is");

    let mutants = Harness.readFile(Harness.ROOT + "/tools/mutate.js");
    Harness.ok(mutants.indexOf("not mutated") >= 0,
               "the mutation report heads its unenumerated list");
    Harness.ok(mutants.indexOf("were not mutated, listed above") >= 0,
               "and its closing line points at that list");
};
