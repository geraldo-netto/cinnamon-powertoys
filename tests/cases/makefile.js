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

cases["RAPL Make targets share one transition implementation"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    Harness.ok(source.indexOf('sh "$(RAPL_TOOL)" install') >= 0,
               "install delegates the whole state change");
    Harness.ok(source.indexOf('sh "$(RAPL_TOOL)" uninstall') >= 0,
               "uninstall delegates to the same owner");
};

function writeExecutable(path, source) {
    GLib.file_set_contents(path, source);
    GLib.chmod(path, 0o700);
}

function transition(action, udevSource, withCounter, signalPublish) {
    let directory = GLib.dir_make_tmp("powertoys-rapl-transition-XXXXXX");
    try {
        let bin = directory + "/bin";
        let rules = directory + "/rules";
        let powercap = directory + "/powercap";
        let source = directory + "/source.rules";
        let destination = rules + "/99-powertoys.rules";
        let log = directory + "/calls";
        GLib.mkdir_with_parents(bin, 0o755);
        GLib.mkdir_with_parents(rules, 0o755);
        GLib.mkdir_with_parents(powercap, 0o755);
        GLib.file_set_contents(source, "GROUP=@GROUP@\n");
        GLib.file_set_contents(destination, "old rule\n");
        GLib.file_set_contents(log, "");
        writeExecutable(bin + "/udevadm", udevSource);
        if (signalPublish) {
            writeExecutable(bin + "/mv",
                "#!/bin/sh\n/bin/mv \"$@\"\nkill -TERM \"$PPID\"\n");
        }
        if (withCounter) {
            let domain = powercap + "/intel-rapl:0";
            GLib.mkdir_with_parents(domain, 0o755);
            GLib.file_set_contents(domain + "/energy_uj", "1\n");
            for (let command of ["chgrp", "chmod"]) {
                writeExecutable(bin + "/" + command,
                    "#!/bin/sh\nprintf '%s %s\\n' '" + command +
                    "' \"$*\" >> \"$POWERTOYS_LOG\"\n");
            }
        }

        let path = bin + ":" + (GLib.getenv("PATH") || "/usr/bin:/bin");
        let tool = Harness.testsDir() + "/../tools/rapl-access.sh";
        let outcome = Harness.settle(done => Privileged._spawn(
            ["env", "PATH=" + path, "DESTDIR=",
             "POWERTOYS_POWERCAP_ROOT=" + powercap, "POWERTOYS_LOG=" + log,
             "sh", tool, action, source, destination, "adm"],
            (status, stderr) => done({
                status: status,
                stderr: stderr,
                destination: GLib.file_test(destination, GLib.FileTest.EXISTS)
                    ? Harness.readFile(destination) : null,
                calls: Harness.readFile(log),
            })), "the RAPL " + action + " transition");
        return outcome;
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

cases["a failed RAPL install restores the previous rule and live policy"] = function () {
    let udev = "#!/bin/sh\n" +
        "printf '%s\\n' \"udevadm $*\" >> \"$POWERTOYS_LOG\"\n" +
        "case \"$*\" in\n" +
        "  *trigger*)\n" +
        "    state=\"$POWERTOYS_LOG.triggered\"\n" +
        "    if [ ! -f \"$state\" ]; then touch \"$state\"; exit 9; fi;;\n" +
        "esac\n";
    let outcome = transition("install", udev, false);
    Harness.ok(outcome.status !== 0, "the failed live trigger fails the install");
    Harness.equal(outcome.destination.trim(), "old rule", "the previous rule is restored");
    Harness.equal((outcome.calls.match(/udevadm control --reload/g) || []).length, 2,
                  "udev is reloaded for publish and rollback");
    Harness.equal((outcome.calls.match(/udevadm trigger/g) || []).length, 2,
                  "the restored policy is replayed");
};

cases["a RAPL publish cannot be interrupted before it is recorded"] = function () {
    let udev = "#!/bin/sh\n" +
        "printf '%s\\n' \"udevadm $*\" >> \"$POWERTOYS_LOG\"\n";
    let outcome = transition("install", udev, false, true);
    Harness.equal(outcome.status, 0,
                  "the signal in the protected publish transition is ignored");
    Harness.equal(outcome.destination.trim(), "GROUP=adm",
                  "the completed rule, not a partial transaction, remains published");
    Harness.equal((outcome.calls.match(/udevadm control --reload/g) || []).length, 1,
                  "the live policy is reloaded after publication");
};

cases["a failed RAPL uninstall still revokes live access"] = function () {
    let udev = "#!/bin/sh\n" +
        "printf '%s\\n' \"udevadm $*\" >> \"$POWERTOYS_LOG\"\n" +
        "case \"$*\" in *control*) exit 8;; esac\n";
    let outcome = transition("uninstall", udev, true);
    Harness.ok(outcome.status !== 0, "the reload failure is surfaced");
    Harness.equal(outcome.destination, null, "the persistent grant remains removed");
    let reload = outcome.calls.indexOf("udevadm control --reload");
    let owner = outcome.calls.indexOf("chgrp root ");
    let mode = outcome.calls.indexOf("chmod 0400 ");
    let trigger = outcome.calls.indexOf("udevadm trigger --subsystem-match=powercap");
    Harness.ok(reload >= 0 && owner > reload && mode > owner && trigger > mode,
               "live counters are revoked and remaining policy replayed despite reload failure");
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
