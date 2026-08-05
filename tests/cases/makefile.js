/* Project operations that are declarative Make recipes rather than loadable
 * code. Hold their ordering to the safety property the command depends on. */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

var cases = {};

cases["the helper install destination is the runtime path"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    Harness.ok(source.indexOf("HELPER_DEST := $(DESTDIR)$(HELPER_PATH)") >= 0,
               "the package root is applied directly to the checked runtime path");
    Harness.ok(source.indexOf("HELPER_DEST := $(HELPER_DIR)/powertoys-helper") < 0,
               "no independently assembled destination can drift from it");
};

cases["RAPL uninstall gives remaining udev rules the final say"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    let start = source.indexOf("uninstall-rapl:");
    let end = source.indexOf("\ncheck:", start);
    let recipe = source.slice(start, end);

    let remove = recipe.indexOf('rm -f -- "$(RAPL_DIR)/$(RAPL_RULE)"');
    let reload = recipe.indexOf("udevadm control --reload");
    let reset = recipe.indexOf('chgrp root "$$f"; chmod 0400 "$$f"');
    let trigger = recipe.indexOf("udevadm trigger --subsystem-match=powercap");
    Harness.ok(remove >= 0 && reload > remove, "the applet rule is removed before reload");
    Harness.ok(reset > reload, "the conservative fallback is applied after that rule is gone");
    Harness.ok(trigger > reset,
               "remaining distribution and administrator rules run after the fallback");
};

cases["RAPL install describes live sensor discovery"] = function () {
    let makefile = Harness.readFile(Harness.testsDir() + "/../Makefile");
    let readme = Harness.readFile(Harness.testsDir() + "/../README.md");
    Harness.ok(makefile.indexOf("open the applet menu to discover the counters now") >= 0,
               "the command names the immediate discovery path");
    Harness.ok(readme.indexOf("periodic topology check finds them\nwithin one minute") >= 0,
               "the documentation names the background path");
    Harness.ok(makefile.indexOf("looks for these counters once") < 0 &&
               readme.indexOf("looks for\nthem once") < 0,
               "the obsolete startup-only instruction is gone");
};

function stagedRapl(group) {
    let directory = GLib.dir_make_tmp("powertoys-rapl-stage-XXXXXX");
    try {
        return Harness.settle(done => Privileged._spawn(
            ["make", "-s", "install-rapl", "DESTDIR=" + directory,
             "RAPL_GROUP=" + group],
            (status, stderr) => {
                let rule = null;
                if (status === 0)
                    rule = Harness.readFile(directory +
                        "/etc/udev/rules.d/99-cinnamon-powertoys-rapl.rules");
                done({ status: status, stderr: stderr, rule: rule });
            }),
            "staged RAPL rule");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

cases["a staged RAPL rule accepts a target-only group"] = function () {
    let outcome = stagedRapl("powertoys-target-only-pt225");
    Harness.equal(outcome.status, 0, "the build host needs no matching account");
    Harness.ok(outcome.rule.indexOf("/usr/bin/chgrp powertoys-target-only-pt225") >= 0,
               "the validated target group is written into the staged rule");
};

cases["a staged RAPL rule rejects unsafe group syntax"] = function () {
    let outcome = stagedRapl("bad/group");
    Harness.ok(outcome.status !== 0, "a value that would corrupt the rule is rejected");
};
