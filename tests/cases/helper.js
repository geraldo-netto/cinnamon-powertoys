/*
 * The privileged helper's transactions, against ordinary files standing in
 * for sysfs nodes. A private copy is pointed at the temporary tree; the
 * shipped helper itself has no environment override that a privileged caller
 * could abuse.
 */

const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

function contents(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("could not read " + path);
    return ByteArray.toString(bytes).trim();
}

function scratch(batteries, body) {
    let directory = GLib.dir_make_tmp("powertoys-helper-XXXXXX");
    let supply = directory + "/power_supply";
    let script = directory + "/powertoys-helper";
    GLib.mkdir_with_parents(supply, 0o755);
    try {
        for (let name in batteries) {
            let battery = supply + "/" + name;
            GLib.mkdir_with_parents(battery, 0o755);
            GLib.file_set_contents(battery + "/charge_control_end_threshold",
                                   String(batteries[name].end) + "\n");
            if (batteries[name].start !== undefined)
                GLib.file_set_contents(battery + "/charge_control_start_threshold",
                                       String(batteries[name].start) + "\n");
        }

        let source = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
            .replace(/^POWER_SUPPLY_DIR=.*$/m, "POWER_SUPPLY_DIR=\"" + supply + "\"");
        return body({ directory: directory, supply: supply, script: script,
                      source: source });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function run(tree, value, refusals) {
    let source = tree.source;
    if (refusals && refusals.length > 0) {
        let conditions = refusals.map(refusal =>
            "{ [ \"$write_target\" = \"" + refusal.path + "\" ] && " +
            "[ \"$write_value\" = \"" + refusal.value + "\" ]; }")
            .join(" ||\n        ");
        let replacement = "try_write() {\n" +
            "    write_target=$1\n" +
            "    write_value=$2\n" +
            "    if " + conditions + "; then\n" +
            "        return 1\n" +
            "    fi\n" +
            "    ( printf '%s\\n' \"$write_value\" > \"$write_target\" ) 2>/dev/null\n" +
            "}";
        source = source.replace(/try_write\(\) \{[\s\S]*?\n\}/, replacement);
    }
    GLib.file_set_contents(tree.script, source);
    GLib.chmod(tree.script, 0o700);

    let helper = new Privileged.PrivilegedHelper(
        [tree.script], () => true, () => {},
        (argv, done) => Privileged._spawn(argv.slice(1), done));
    return Harness.settle(done => helper.run(["charge-threshold", String(value)], done),
                          "the helper transaction");
}

var cases = {};

cases["charge writes begin only after every battery passes preflight"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: "asleep" } }, tree => {
        let outcome = run(tree, 60);
        Harness.equal(outcome.code, "unavailable", "the unreadable topology is reported");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_start_threshold"), "70",
                      "the first start was not lowered");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_end_threshold"), "80",
                      "and its end was not changed");
    });
};

cases["charge writes update every battery as one transaction"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: 90 } }, tree => {
        let outcome = run(tree, 60);
        Harness.equal(outcome.applied, true, "the set applied");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_start_threshold"), "55",
                      "a start that would block the end is lowered first");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_end_threshold"), "60",
                      "the first end");
        Harness.equal(contents(tree.supply + "/BAT1/charge_control_start_threshold"), "40",
                      "an already valid start is untouched");
        Harness.equal(contents(tree.supply + "/BAT1/charge_control_end_threshold"), "60",
                      "the second end");
    });
};

cases["a refused charge write restores every completed write"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: 90 } }, tree => {
        let refused = tree.supply + "/BAT1/charge_control_end_threshold";
        let outcome = run(tree, 60, [{ path: refused, value: "60" }]);
        Harness.equal(outcome.code, "change-failed-restored", "restoration is explicit");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_start_threshold"), "70",
                      "the adjusted start was restored");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_end_threshold"), "80",
                      "the earlier end was restored");
        Harness.equal(contents(tree.supply + "/BAT1/charge_control_end_threshold"), "90",
                      "the refused end remains original");
    });
};

cases["a refused charge rollback is reported separately"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: 90 } }, tree => {
        let first = tree.supply + "/BAT0/charge_control_end_threshold";
        let second = tree.supply + "/BAT1/charge_control_end_threshold";
        let outcome = run(tree, 60, [
            { path: second, value: "60" },
            { path: first, value: "80" },
        ]);
        Harness.equal(outcome.code, "rollback-failed", "the partial restoration is visible");
        Harness.equal(contents(first), "60", "the node whose restoration failed stays changed");
    });
};
