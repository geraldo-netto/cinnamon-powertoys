/* Continuous integration is a Make invocation wrapped in a YAML file, so the
 * properties worth holding are the ones the Makefile cannot state: that a
 * superseded run stops consuming a runner, and that nothing in a run can wait
 * forever. Read as text - the runner has no YAML parser, and every property
 * here is a single documented key. */

const Harness = imports.harness;

function workflow(name) {
    return Harness.readFile(Harness.testsDir() + "/../.github/workflows/" + name);
}

var cases = {};

cases["a superseded run is cancelled rather than left holding a runner"] = function () {
    let source = workflow("check.yml");
    let match = source.match(/^concurrency:\n((?:  .*\n)+)/m);
    Harness.ok(match !== null, "the workflow declares a concurrency group");
    Harness.ok(match[1].indexOf("github.workflow") >= 0 &&
               match[1].indexOf("github.ref") >= 0,
               "grouped by workflow and ref, so unrelated branches do not cancel each other");
    Harness.ok(/cancel-in-progress:\s*true/.test(match[1]),
               "and the superseded run is actually cancelled");
};

cases["every job and every waiting step states a timeout"] = function () {
    let source = workflow("check.yml");
    let jobs = source.slice(source.indexOf("\njobs:\n"));

    let jobNames = jobs.match(/^ {2}[A-Za-z0-9_-]+:$/gm) || [];
    Harness.ok(jobNames.length > 0, "the workflow defines at least one job");
    for (let heading of jobNames) {
        let start = jobs.indexOf(heading);
        let body = jobs.slice(start + heading.length);
        let next = body.search(/^ {2}[A-Za-z0-9_-]+:$/m);
        if (next >= 0)
            body = body.slice(0, next);
        let header = body.slice(0, body.indexOf("\n    steps:"));
        Harness.ok(/^ {4}timeout-minutes: \d+$/m.test(header),
                   heading.trim() + " states a job timeout");
    }

    /* A job timeout bounds the run; a step timeout says which step stopped.
     * Every step that reaches the network or runs the suite states one. */
    let steps = jobs.split(/^ {6}- /m).slice(1);
    for (let step of steps) {
        let named = step.match(/^name: (.*)$/m);
        if (!named)
            continue;
        Harness.ok(/^ {8}timeout-minutes: \d+$/m.test(step),
                   "step \"" + named[1] + "\" states a timeout");
    }
};
