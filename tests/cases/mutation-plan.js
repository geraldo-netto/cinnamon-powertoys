/* The mutation runner may reorder tests, but it may never filter them. */

const Harness = imports.harness;
const MutationPlan = imports.mutation_plan;

var cases = {};

/* Split the loader spell so this tool-only case does not accidentally look
 * like a runtime consumer when the planner reads its own source. */
function librarySource(name) {
    return "const Value = re" + "quire(\"./lib/" + name + ".js\");";
}

function caseSource(name) {
    return "Harness.require" + "Xlet(\"./lib/" + name + ".js\");";
}

function dynamicCaseSource() {
    return "Harness.require" + "Xlet(\"./lib/\" + name + \".js\");";
}

cases["priorities reorder without dropping case files"] = function () {
    let original = ["alerts", "ddc", "install", "loading"];
    Harness.deepEqual(
        MutationPlan.prioritize(original, ["ddc", "loading", "missing", "ddc"]),
        ["ddc", "loading", "alerts", "install"],
        "every original case file remains exactly once");
};

cases["a mutation prioritizes direct and transitive consumers"] = function () {
    let libraries = {
        "lib/io.js": "",
        "lib/hardware.js": librarySource("io"),
        "lib/cpu.js": librarySource("hardware"),
        "lib/privileged.js": "",
    };
    let testCases = {
        cpu: caseSource("cpu"),
        hardware: caseSource("hardware"),
        install: caseSource("privileged"),
        io: caseSource("io"),
        loading: dynamicCaseSource(),
    };

    Harness.deepEqual(
        MutationPlan.impactedCases("lib/io.js", libraries, testCases),
        ["io", "hardware", "cpu", "loading"],
        "nearest consumers run first and unrelated installation cases stay in fallback");
};

cases["a matching case stays first without a visible static import"] = function () {
    Harness.deepEqual(
        MutationPlan.impactedCases("lib/ddc.js", { "lib/ddc.js": "" }, {
            ddc: "build the module path through a fixture",
            loading: dynamicCaseSource(),
        }),
        ["ddc", "loading"],
        "the conventional case name is a safe performance hint");
};
