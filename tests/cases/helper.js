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
            GLib.file_set_contents(battery + "/type",
                                   (batteries[name].type || "Battery") + "\n");
            GLib.file_set_contents(battery + "/charge_control_end_threshold",
                                   String(batteries[name].end) + "\n");
            if (batteries[name].start !== undefined)
                GLib.file_set_contents(battery + "/charge_control_start_threshold",
                                       String(batteries[name].start) + "\n");
        }

        let source = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
            .replace(/^POWER_SUPPLY_DIR=.*$/m, "POWER_SUPPLY_DIR=\"" + supply + "\"")
            .replace(/^LOCK_FILE=.*$/m, "LOCK_FILE=\"" + directory + "/lock\"");
        return body({ directory: directory, supply: supply, script: script,
                      source: source });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function cpuScratch(policies, body) {
    let directory = GLib.dir_make_tmp("powertoys-helper-cpu-XXXXXX");
    let cpu = directory + "/cpu";
    let cpufreq = cpu + "/cpufreq";
    let script = directory + "/powertoys-helper";
    GLib.mkdir_with_parents(cpufreq, 0o755);
    try {
        for (let name in policies) {
            let policy = cpufreq + "/" + name;
            GLib.mkdir_with_parents(policy, 0o755);
            GLib.file_set_contents(policy + "/scaling_available_governors",
                                   policies[name].governors + "\n");
            GLib.file_set_contents(policy + "/scaling_governor",
                                   policies[name].governor + "\n");
        }
        let source = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
            .replace(/^CPU_DIR=.*$/m, "CPU_DIR=\"" + cpu + "\"")
            .replace(/^LOCK_FILE=.*$/m, "LOCK_FILE=\"" + directory + "/lock\"");
        return body({ directory: directory, cpu: cpu, cpufreq: cpufreq,
                      script: script, source: source });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

/*
 * A stand-in for the two ACPI firmware nodes. `profile` is what the machine is
 * on now; `choices` is what it says it will take - absent, unreadable or empty
 * are each a different way of not answering, and each has to read as one.
 */
function readable(path) {
    try {
        return GLib.file_get_contents(path)[0];
    } catch (error) {
        return false;
    }
}

function platformScratch(options, body) {
    let directory = GLib.dir_make_tmp("powertoys-helper-platform-XXXXXX");
    let profile = directory + "/platform_profile";
    let choices = directory + "/platform_profile_choices";
    let script = directory + "/powertoys-helper";
    try {
        if (options.profile !== undefined)
            GLib.file_set_contents(profile, options.profile + "\n");
        if (options.choices !== undefined)
            GLib.file_set_contents(choices, options.choices + "\n");
        if (options.unreadableChoices)
            GLib.chmod(choices, 0o200);

        let source = Harness.readFile(Harness.xletDir() + "/powertoys-helper")
            .replace(/^PLATFORM_PROFILE=.*$/m, "PLATFORM_PROFILE=\"" + profile + "\"")
            .replace(/^PLATFORM_PROFILE_CHOICES=.*$/m,
                     "PLATFORM_PROFILE_CHOICES=\"" + choices + "\"")
            .replace(/^LOCK_FILE=.*$/m, "LOCK_FILE=\"" + directory + "/lock\"");
        return body({ directory: directory, profile: profile, choices: choices,
                      script: script, source: source });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function run(tree, args, refusals) {
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
        [tree.script], () => true,
        (argv, done) => Privileged._spawn(argv.slice(1), done),
        /* This is about what the helper writes, not about the handshake it
         * answers separately; the spawn stub drops pkexec's own argument. */
        (path, onDone) => onDone(true, ""));
    return Harness.settle(done => helper.run(args.map(value => String(value)), done),
                          "the helper transaction");
}

var cases = {};

cases["charge writes begin only after every battery passes preflight"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: "asleep" } }, tree => {
        let outcome = run(tree, ["charge-threshold", 60]);
        Harness.equal(outcome.code, "unavailable", "the unreadable topology is reported");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_start_threshold"), "70",
                      "the first start was not lowered");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_end_threshold"), "80",
                      "and its end was not changed");
    });
};

cases["charge writes update every battery as one transaction"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: 90 } }, tree => {
        let outcome = run(tree, ["charge-threshold", 60]);
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

cases["extra arguments are rejected before the transaction lock"] = function () {
    cpuScratch({}, tree => {
        let outcome = run(tree, ["boost", 1, "unexpected"]);
        Harness.equal(outcome.code, "invalid-invocation", "the malformed call is rejected");
        Harness.equal(GLib.file_test(tree.directory + "/lock", GLib.FileTest.EXISTS), false,
                      "validation happens before the machine-wide lock is opened");
    });
};

cases["charge writes target only supplies declared as batteries"] = function () {
    scratch({
        BAT0: { type: "Battery", start: 70, end: 80 },
        hidpp_battery_0: { type: "UPS", start: 40, end: 90 },
    }, tree => {
        let outcome = run(tree, ["charge-threshold", 60]);
        Harness.equal(outcome.applied, true, "the battery change applied");
        Harness.equal(contents(tree.supply + "/BAT0/charge_control_end_threshold"), "60",
                      "the same battery the UI discovered is written");
        Harness.equal(contents(tree.supply +
                               "/hidpp_battery_0/charge_control_end_threshold"), "90",
                      "a non-battery threshold is outside the transaction");
    });
};

cases["a refused charge write restores every completed write"] = function () {
    scratch({ BAT0: { start: 70, end: 80 }, BAT1: { start: 40, end: 90 } }, tree => {
        let refused = tree.supply + "/BAT1/charge_control_end_threshold";
        let outcome = run(tree, ["charge-threshold", 60],
                          [{ path: refused, value: "60" }]);
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
        let outcome = run(tree, ["charge-threshold", 60], [
            { path: second, value: "60" },
            { path: first, value: "80" },
        ]);
        Harness.equal(outcome.code, "rollback-failed", "the partial restoration is visible");
        Harness.equal(contents(first), "60", "the node whose restoration failed stays changed");
    });
};

cases["CPU policy writes begin only after every policy accepts the value"] = function () {
    cpuScratch({
        policy0: { governors: "performance powersave", governor: "powersave" },
        policy1: { governors: "powersave", governor: "powersave" },
    }, tree => {
        let outcome = run(tree, ["governor", "performance"]);
        Harness.equal(outcome.code, "invalid-value", "the incompatible policy is named before writes");
        Harness.equal(contents(tree.cpufreq + "/policy0/scaling_governor"), "powersave",
                      "the compatible policy was not changed first");
        Harness.equal(contents(tree.cpufreq + "/policy1/scaling_governor"), "powersave",
                      "the incompatible policy remains unchanged");
    });
};

cases["a refused CPU policy write restores earlier policies"] = function () {
    cpuScratch({
        policy0: { governors: "performance powersave", governor: "powersave" },
        policy1: { governors: "performance powersave", governor: "powersave" },
    }, tree => {
        let refused = tree.cpufreq + "/policy1/scaling_governor";
        let outcome = run(tree, ["governor", "performance"],
                          [{ path: refused, value: "performance" }]);
        Harness.equal(outcome.code, "change-failed-restored", "restoration is reported");
        Harness.equal(contents(tree.cpufreq + "/policy0/scaling_governor"), "powersave",
                      "the earlier policy was restored");
        Harness.equal(contents(tree.cpufreq + "/policy1/scaling_governor"), "powersave",
                      "the refused policy remains original");
    });
};

cases["a CPU policy transaction updates every policy"] = function () {
    cpuScratch({
        policy0: { governors: "performance powersave", governor: "powersave" },
        policy1: { governors: "powersave performance", governor: "powersave" },
    }, tree => {
        let outcome = run(tree, ["governor", "performance"]);
        Harness.equal(outcome.applied, true, "the transaction applied");
        Harness.equal(contents(tree.cpufreq + "/policy0/scaling_governor"), "performance",
                      "the first policy");
        Harness.equal(contents(tree.cpufreq + "/policy1/scaling_governor"), "performance",
                      "the second policy");
    });
};

cases["privileged helper mutations serialize across processes"] = function () {
    cpuScratch({}, tree => {
        let boost = tree.cpufreq + "/boost";
        let log = tree.directory + "/order";
        let runner = tree.directory + "/run-both";
        GLib.file_set_contents(boost, "0\n");
        let source = tree.source.replace("case \"$command\" in",
            "printf 'start %s\\n' \"$argument\" >> \"" + log + "\"\n" +
            "if [ \"$argument\" = 1 ]; then sleep 0.2; fi\n" +
            "printf 'end %s\\n' \"$argument\" >> \"" + log + "\"\n\n" +
            "case \"$command\" in");
        GLib.file_set_contents(tree.script, source);
        GLib.chmod(tree.script, 0o700);
        GLib.file_set_contents(runner,
            "#!/bin/sh\n" +
            "\"" + tree.script + "\" boost 1 &\n" +
            "first=$!\n" +
            "while ! grep -q '^start 1$' \"" + log + "\" 2>/dev/null; do sleep 0.01; done\n" +
            "\"" + tree.script + "\" boost 0 &\n" +
            "second=$!\n" +
            "wait \"$first\"\n" +
            "wait \"$second\"\n");
        GLib.chmod(runner, 0o700);

        let [, , , status] = GLib.spawn_sync(null, [runner], null,
                                             GLib.SpawnFlags.SEARCH_PATH, null);
        Harness.equal(status, 0, "both helper processes finish");
        Harness.equal(contents(log), "start 1\nend 1\nstart 0\nend 0",
                      "the second transaction begins only after the first releases its lock");
    });
};

cases["the firmware profile is written from the list the firmware publishes"] = function () {
    platformScratch({ profile: "balanced", choices: "quiet balanced performance" }, tree => {
        let outcome = run(tree, ["platform-profile", "performance"]);
        Harness.equal(outcome.applied, true, "the profile applied");
        Harness.equal(contents(tree.profile), "performance", "and the firmware node holds it");
    });
};

cases["a profile the firmware does not publish is refused as a value"] = function () {
    platformScratch({ profile: "balanced", choices: "quiet balanced" }, tree => {
        let outcome = run(tree, ["platform-profile", "performance"]);
        Harness.equal(outcome.code, "invalid-value", "the machine answered, and said no");
        Harness.equal(contents(tree.profile), "balanced", "nothing was written");
    });
};

cases["a firmware that will not say what it accepts is not a bad value"] = function () {
    /* Each of these used to report invalid-value, which tells the user to
     * correct a choice that was never the problem. */
    platformScratch({ profile: "balanced" }, tree => {
        Harness.equal(run(tree, ["platform-profile", "performance"]).code, "unsupported",
                      "no choices node at all is a machine that cannot be asked");
    });
    platformScratch({ profile: "balanced", choices: "" }, tree => {
        Harness.equal(run(tree, ["platform-profile", "performance"]).code, "unavailable",
                      "an empty answer is no answer");
    });
};

cases["a choices node that cannot be read has refused nothing"] = function () {
    platformScratch({ profile: "balanced", choices: "quiet balanced performance",
                      unreadableChoices: true }, tree => {
        /* Anybody who can read a mode 0200 file - root, most obviously - has
         * no unreadable node here to exercise. */
        if (readable(tree.choices))
            Harness.skip("this user can read a write-only file");
        Harness.equal(run(tree, ["platform-profile", "performance"]).code, "unavailable",
                      "a node that cannot be read has not refused anything");
        Harness.equal(contents(tree.profile), "balanced", "and nothing was written");
    });
};

cases["a machine with no firmware profile says so"] = function () {
    platformScratch({ choices: "quiet balanced" }, tree => {
        Harness.equal(run(tree, ["platform-profile", "quiet"]).code, "unsupported",
                      "there is nothing to write to");
    });
};

/*
 * The helper's vocabulary, from both sides.
 *
 * The helper dispatches on a command word and refuses anything else; the
 * applet's libraries write those words into argument vectors. Nothing held
 * the two sets together, and neither end fails on its own: a command the
 * helper stopped implementing is refused as an invalid invocation at the
 * moment somebody moves a slider, and a command the helper implements that no
 * module sends is privileged code that ships and runs on nobody's machine.
 *
 * The prose in lib/reading.js says "the helper takes five commands"; this is
 * what makes that sentence true rather than remembered.
 */
cases["the helper implements what the applet sends, and only that"] = function () {
    const Scan = imports.scan;
    const Sources = imports.sources;

    let script = Harness.readFile(Harness.xletDir() + "/powertoys-helper");
    let dispatch = /case "\$command" in([\s\S]*?)\nesac/.exec(script);
    Harness.ok(dispatch !== null, "the helper dispatches on a command word");
    let implemented = {};
    let branch = /^\s*([a-z][a-z-]*)\)/gm;
    let match;
    while ((match = branch.exec(dispatch[1])) !== null)
        implemented[match[1]] = true;

    let sent = {};
    for (let relative of Sources.jsFiles(Harness.xletDir(), "")) {
        let source = Harness.readFile(Harness.xletDir() + "/" + relative);
        let written = Scan.literals(source);
        let calls = /_runner\(\s*\[\s*"([a-z][a-z-]*)"/g;
        while ((match = calls.exec(source)) !== null) {
            if (written.indexOf(match[1]) >= 0)
                sent[match[1]] = relative;
        }
    }

    let names = Object.keys(implemented).sort();
    Harness.ok(names.length > 3, "there are " + names.length + " commands to check");
    Harness.deepEqual(names.filter(name => sent[name] === undefined), [],
                      "a privileged command nothing sends is privileged code nobody runs");
    Harness.deepEqual(Object.keys(sent).sort().filter(name => !implemented[name]), [],
                      "and a command the helper does not implement is refused at the slider");
};

cases["every change the menu describes is one the helper takes"] = function () {
    /* lib/reading.js turns an argument vector back into a sentence for the
     * notification. A branch for a word the helper does not take is a
     * sentence nobody will ever be shown, which is what a rename on the
     * helper's side leaves behind. */
    const Reading = Harness.requireXlet("./lib/reading.js");
    let described = /switch \(args\[0\]\) \{([\s\S]*?)\n\}/
        .exec(Harness.readFile(Harness.xletDir() + "/lib/reading.js"));
    Harness.ok(described !== null, "the descriptions are a switch on the command");
    let script = Harness.readFile(Harness.xletDir() + "/powertoys-helper");
    let branch = /case "([a-z][a-z-]*)":/g;
    let match;
    let checked = 0;
    while ((match = branch.exec(described[1])) !== null) {
        checked++;
        Harness.ok(new RegExp("^\\s*" + match[1] + "\\)", "m").test(script),
                   match[1] + " is described by the menu and taken by the helper");
        Harness.ok(Reading.describeChange([match[1], "1"]) !== "",
                   match[1] + " describes into something");
    }
    Harness.ok(checked > 2, "only " + checked + " descriptions checked, which is too few");
};
