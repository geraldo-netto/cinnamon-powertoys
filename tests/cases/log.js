/*
 * Where trouble gets reported.
 *
 * Thirty lines, no cases, and three ways out: a sink somebody set, Cinnamon's
 * own logError, and plain printerr for everything that is not Cinnamon. The
 * first is what every other case file here uses to read what a library said,
 * so it was exercised constantly and never checked; the other two had nothing
 * at all on them, which for the shell path means the line that carries a
 * failure to ~/.xsession-errors was never once run.
 *
 * The order of the three is the whole of what this file decides, and getting
 * it wrong is silent by construction: a message that goes nowhere looks
 * exactly like a message nobody needed to send.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Log = Harness.requireXlet("./lib/log.js");

/* Runs body with the global Cinnamon would have put there, and takes it away
 * again. The module looks the name up when it logs, not when it loads. */
function asCinnamon(body) {
    let lines = [];
    let had = Object.prototype.hasOwnProperty.call(globalThis, "global");
    let previous = globalThis.global;
    globalThis.global = { logError: line => lines.push(line) };
    try {
        body(lines);
    } finally {
        if (had)
            globalThis.global = previous;
        else
            delete globalThis.global;
    }
}

/* And with printerr replaced, which is where a message goes outside the
 * shell - the runner, the parse check, a mutation run. */
function withPrinterr(body) {
    let lines = [];
    let real = globalThis.printerr;
    globalThis.printerr = line => lines.push(line);
    try {
        body(lines);
    } finally {
        globalThis.printerr = real;
    }
}

var cases = {};

cases["a sink takes every message, and nothing else does"] = function () {
    /* What the rest of this suite relies on to read what a library said. */
    withPrinterr(function (printed) {
        asCinnamon(function (shell) {
            let lines = [];
            Log.setSink(line => lines.push(line));
            try {
                Log.error("something went wrong");
            } finally {
                Log.setSink(null);
            }
            Harness.deepEqual(lines, ["[powertoys] something went wrong"], "the sink got it");
            Harness.deepEqual(shell, [], "and the shell did not");
            Harness.deepEqual(printed, [], "nor the terminal");
        });
    });
};

cases["inside Cinnamon it goes to the shell's log"] = function () {
    /*
     * The line that puts a failure in ~/.xsession-errors with a stack trace
     * behind it, which is the only trace an installed applet leaves. It had
     * never been run: outside the shell there is no global to find, and no
     * case had ever made one.
     */
    withPrinterr(function (printed) {
        asCinnamon(function (shell) {
            Log.error("ddcutil did not answer in time");
            Harness.deepEqual(shell, ["[powertoys] ddcutil did not answer in time"],
                              "the shell was told");
            Harness.deepEqual(printed, [], "and it was not said twice");
        });
    });
};

cases["outside it, the terminal will do"] = function () {
    withPrinterr(function (printed) {
        Log.error("no cpufreq policy found");
        Harness.deepEqual(printed, ["[powertoys] no cpufreq policy found"], "printed");
    });
};

cases["a shell that has no logError is not the shell"] = function () {
    /*
     * `global` is a name anything could have taken. What decides is whether
     * it carries the call this needs, not whether the name exists - and a
     * message dropped between the two is a failure nobody hears about.
     */
    withPrinterr(function (printed) {
        let had = Object.prototype.hasOwnProperty.call(globalThis, "global");
        let previous = globalThis.global;
        globalThis.global = { something: "else" };
        try {
            Log.error("still worth saying");
        } finally {
            if (had)
                globalThis.global = previous;
            else
                delete globalThis.global;
        }
        Harness.deepEqual(printed, ["[powertoys] still worth saying"],
                          "it fell through to the terminal rather than being dropped");
    });
};

cases["every message says which applet it came from"] = function () {
    /*
     * The prefix is the whole of what makes a line in a shared log findable:
     * ~/.xsession-errors is every applet on the panel, and a line saying
     * "no cpufreq policy found" with nothing in front of it belongs to
     * nobody.
     */
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        Fuzz.forAll({ what: "the prefix", runs: 300 },
                    random => Fuzz.value(random),
                    input => {
                        lines.length = 0;
                        Fuzz.answers(() => Log.error(input));
                        if (lines.length !== 1)
                            throw new Error("said " + lines.length + " things");
                        Fuzz.isString(lines[0], "the line");
                        if (lines[0].indexOf("[powertoys] ") !== 0)
                            throw new Error("no prefix: " + JSON.stringify(lines[0]));
                    });
    } finally {
        Log.setSink(null);
    }
};

cases["setting the sink back to nothing puts the old route back"] = function () {
    withPrinterr(function (printed) {
        Log.setSink(() => {});
        Log.setSink(null);
        Log.error("back to the terminal");
        Harness.deepEqual(printed, ["[powertoys] back to the terminal"], "printed again");

        Log.setSink(() => {});
        Log.setSink(undefined);
        Log.error("and undefined means the same as null");
        Harness.equal(printed.length, 2, "printed once more");
    });
};
