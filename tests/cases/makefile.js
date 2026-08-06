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

cases["policy installation delegates the paired transition"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    Harness.ok(source.indexOf('sh "$(POLICY_TOOL)"') >= 0,
               "the Make target has one owner for both publications");
    Harness.ok(source.indexOf('install -m 0755 "$(UUID)/powertoys-helper"') < 0,
               "the helper is not published independently in the recipe");
    Harness.ok(source.indexOf('install -m 0644 "polkit/$(POLICY)"') < 0,
               "nor is the action");
    Harness.ok(source.indexOf('sh "$(POLICY_TOOL)" uninstall') >= 0,
               "uninstall uses the same transition owner");
    Harness.equal((source.match(/"\$\(POLICY_LOCK\)"/g) || []).length, 2,
                  "install and uninstall pass the same lock target");
};

function policyInstall(options) {
    let directory = GLib.dir_make_tmp("powertoys-policy-install-XXXXXX");
    try {
        let source = directory + "/source";
        let helperSource = source + "/helper";
        let policySource = source + "/action.policy";
        let helper = directory + "/root/usr/local/lib/powertoys/helper";
        let policy = directory + "/root/usr/share/polkit-1/actions/action.policy";
        GLib.mkdir_with_parents(source, 0o755);
        GLib.mkdir_with_parents(GLib.path_get_dirname(helper), 0o755);
        GLib.mkdir_with_parents(GLib.path_get_dirname(policy), 0o755);
        GLib.file_set_contents(helperSource, "new helper\n");
        GLib.file_set_contents(policySource, "new policy\n");
        if (options.existing) {
            GLib.file_set_contents(helper, "old helper\n");
            GLib.file_set_contents(policy, "old policy\n");
        }

        let path = GLib.getenv("PATH") || "/usr/bin:/bin";
        if (options.failPolicyPublish || options.signalHelperPublish) {
            let bin = directory + "/bin";
            GLib.mkdir_with_parents(bin, 0o755);
            let wrapper = "#!/bin/sh\n";
            if (options.failPolicyPublish) {
                wrapper +=
                    "case \"$*\" in *'.powertoys-policy.new.'*) exit 17;; esac\n";
            }
            if (options.signalHelperPublish) {
                wrapper +=
                    "case \"$*\" in\n" +
                    "  *'.powertoys-helper.new.'*)\n" +
                    "    /bin/mv \"$@\" || exit $?\n" +
                    "    kill -TERM \"$PPID\"\n" +
                    "    exit 0;;\n" +
                    "esac\n";
            }
            wrapper += "exec /bin/mv \"$@\"\n";
            writeExecutable(bin + "/mv", wrapper);
            path = bin + ":" + path;
        }

        let tool = Harness.testsDir() + "/../tools/install-policy.sh";
        return Harness.settle(done => Privileged._spawn(
            ["env", "PATH=" + path, "sh", tool,
             "install", helperSource, helper, policySource, policy, directory],
            (status, stderr) => done({
                status: status,
                stderr: stderr,
                helper: GLib.file_test(helper, GLib.FileTest.EXISTS)
                    ? Harness.readFile(helper).trim() : null,
                policy: GLib.file_test(policy, GLib.FileTest.EXISTS)
                    ? Harness.readFile(policy).trim() : null,
                helperExecutable: GLib.file_test(helper, GLib.FileTest.IS_EXECUTABLE),
            })), "the paired policy install");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function policyUninstall(options) {
    let directory = GLib.dir_make_tmp("powertoys-policy-uninstall-XXXXXX");
    try {
        let source = directory + "/source";
        let helperSource = source + "/helper";
        let policySource = source + "/action.policy";
        let helper = directory + "/root/usr/local/lib/powertoys/helper";
        let policy = directory + "/root/usr/share/polkit-1/actions/action.policy";
        GLib.mkdir_with_parents(source, 0o755);
        GLib.mkdir_with_parents(GLib.path_get_dirname(helper), 0o755);
        GLib.mkdir_with_parents(GLib.path_get_dirname(policy), 0o755);
        GLib.file_set_contents(helperSource, "source helper\n");
        GLib.file_set_contents(policySource, "source policy\n");
        GLib.file_set_contents(helper, "installed helper\n");
        GLib.file_set_contents(policy, "installed policy\n");

        let path = GLib.getenv("PATH") || "/usr/bin:/bin";
        if (options.failPolicyRemoval || options.failRemovalAndRestore ||
                options.signalHelperRemoval) {
            let bin = directory + "/bin";
            GLib.mkdir_with_parents(bin, 0o755);
            let wrapper = "#!/bin/sh\n";
            if (options.failPolicyRemoval) {
                wrapper +=
                    "if [ \"$2\" = \"" + policy + "\" ]; then exit 19; fi\n";
            }
            if (options.failRemovalAndRestore) {
                let failed = directory + "/policy-removal-failed";
                wrapper +=
                    "if [ \"$2\" = \"" + policy + "\" ] && " +
                    "[ ! -e \"" + failed + "\" ]; then\n" +
                    "  touch \"" + failed + "\"\n" +
                    "  exit 19\n" +
                    "fi\n" +
                    "case \"$2\" in *'.powertoys-helper.remove.'*) exit 20;; esac\n";
            }
            if (options.signalHelperRemoval) {
                wrapper +=
                    "if [ \"$2\" = \"" + helper + "\" ]; then\n" +
                    "  /bin/mv \"$@\" || exit $?\n" +
                    "  kill -TERM \"$PPID\"\n" +
                    "  exit 0\n" +
                    "fi\n";
            }
            wrapper += "exec /bin/mv \"$@\"\n";
            writeExecutable(bin + "/mv", wrapper);
            path = bin + ":" + path;
        }

        let tool = Harness.testsDir() + "/../tools/install-policy.sh";
        return Harness.settle(done => Privileged._spawn(
            ["env", "PATH=" + path, "sh", tool,
             "uninstall", helperSource, helper, policySource, policy, directory],
            (status, stderr) => done({
                status: status,
                stderr: stderr,
                helper: GLib.file_test(helper, GLib.FileTest.EXISTS)
                    ? Harness.readFile(helper).trim() : null,
                policy: GLib.file_test(policy, GLib.FileTest.EXISTS)
                    ? Harness.readFile(policy).trim() : null,
            })), "the paired policy uninstall");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

cases["a failed policy publication restores the previous pair"] = function () {
    let outcome = policyInstall({ existing: true, failPolicyPublish: true });
    Harness.equal(outcome.status, 17, "the publication failure is preserved");
    Harness.equal(outcome.helper, "old helper", "the old helper is restored");
    Harness.equal(outcome.policy, "old policy", "the old action remains in force");
};

cases["a failed policy uninstall restores the previous pair"] = function () {
    let outcome = policyUninstall({ failPolicyRemoval: true });
    Harness.equal(outcome.status, 19, "the removal failure is preserved");
    Harness.equal(outcome.helper, "installed helper", "the helper is restored");
    Harness.equal(outcome.policy, "installed policy", "the action remains in force");
};

cases["a policy uninstall removes the complete pair"] = function () {
    let outcome = policyUninstall({});
    Harness.equal(outcome.status, 0, "the removal commits");
    Harness.equal(outcome.helper, null, "the privileged helper is absent");
    Harness.equal(outcome.policy, null, "the matching action is absent");
};

cases["an unrestorable uninstall completes a safe removal"] = function () {
    let outcome = policyUninstall({ failRemovalAndRestore: true });
    Harness.ok(outcome.status !== 0, "the failed restoration is reported");
    Harness.equal(outcome.helper, null, "no orphan privileged helper is exposed");
    Harness.equal(outcome.policy, null, "the action is withdrawn with it");
    Harness.ok(outcome.stderr.indexOf("safely removed") >= 0,
               "the deliberately completed state is named: " + outcome.stderr);
};

cases["a helper removal signal cannot expose half an uninstall"] = function () {
    let outcome = policyUninstall({ signalHelperRemoval: true });
    Harness.equal(outcome.status, 0,
                  "the signal inside the protected removal is deferred");
    Harness.equal(outcome.helper, null, "the helper stays removed");
    Harness.equal(outcome.policy, null, "and the action is removed with it");
};

cases["policy uninstall waits for an in-flight installation"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-policy-lock-XXXXXX");
    try {
        let bin = directory + "/bin";
        let helperSource = directory + "/helper.source";
        let policySource = directory + "/policy.source";
        let helper = directory + "/live/helper";
        let policy = directory + "/live/action.policy";
        let started = directory + "/helper-published";
        let runner = directory + "/run-race";
        let tool = Harness.testsDir() + "/../tools/install-policy.sh";
        GLib.mkdir_with_parents(bin, 0o755);
        GLib.mkdir_with_parents(GLib.path_get_dirname(helper), 0o755);
        GLib.file_set_contents(helperSource, "new helper\n");
        GLib.file_set_contents(policySource, "new policy\n");
        writeExecutable(bin + "/mv",
            "#!/bin/sh\n" +
            "case \"$*\" in\n" +
            "  *'.powertoys-helper.new.'*)\n" +
            "    /bin/mv \"$@\" || exit $?\n" +
            "    touch \"" + started + "\"\n" +
            "    sleep 0.2\n" +
            "    exit 0;;\n" +
            "esac\n" +
            "exec /bin/mv \"$@\"\n");
        writeExecutable(runner,
            "#!/bin/sh\n" +
            "PATH=\"" + bin + ":$PATH\" sh \"" + tool + "\" install " +
                "\"" + helperSource + "\" \"" + helper + "\" " +
                "\"" + policySource + "\" \"" + policy + "\" \"" + directory + "\" &\n" +
            "installer=$!\n" +
            "while [ ! -f \"" + started + "\" ]; do sleep 0.01; done\n" +
            "sh \"" + tool + "\" uninstall \"" + helperSource + "\" " +
                "\"" + helper + "\" \"" + policySource + "\" " +
                "\"" + policy + "\" \"" + directory + "\" &\n" +
            "uninstaller=$!\n" +
            "wait \"$installer\"\n" +
            "wait \"$uninstaller\"\n");

        let outcome = Harness.settle(done => Privileged._spawn(
            [runner], (status, stderr) => done({ status: status, stderr: stderr })),
            "concurrent policy transitions");
        Harness.equal(outcome.status, 0, "both transitions complete: " + outcome.stderr);
        Harness.equal(GLib.file_test(helper, GLib.FileTest.EXISTS), false,
                      "the later uninstall removes the committed helper");
        Harness.equal(GLib.file_test(policy, GLib.FileTest.EXISTS), false,
                      "and cannot race into an orphan action");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["a failed first policy install publishes neither file"] = function () {
    let outcome = policyInstall({ failPolicyPublish: true });
    Harness.equal(outcome.status, 17, "the publication failure is preserved");
    Harness.equal(outcome.helper, null, "the uncommitted helper is removed");
    Harness.equal(outcome.policy, null, "no partial action is visible");
};

cases["a policy transaction publishes the complete staged pair"] = function () {
    let outcome = policyInstall({ existing: true });
    Harness.equal(outcome.status, 0, "both publications committed");
    Harness.equal(outcome.helper, "new helper", "the staged helper is live");
    Harness.equal(outcome.policy, "new policy", "the staged action is live");
    Harness.equal(outcome.helperExecutable, true, "the helper has its executable mode");
};

cases["a policy publish signal cannot expose half a transaction"] = function () {
    let outcome = policyInstall({ existing: true, signalHelperPublish: true });
    Harness.equal(outcome.status, 0,
                  "the signal inside the protected publication is deferred");
    Harness.equal(outcome.helper, "new helper", "the helper publication is recorded");
    Harness.equal(outcome.policy, "new policy", "and the matching action is committed");
};

cases["the staged Make target publishes the runtime policy pair"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-policy-stage-XXXXXX");
    try {
        let outcome = Harness.settle(done => Privileged._spawn(
            ["make", "-s", "install-policy", "DESTDIR=" + directory],
            (status, stderr) => done({ status: status, stderr: stderr })),
        "the staged policy Make target");
        Harness.equal(outcome.status, 0, "the delegated Make target completes: " + outcome.stderr);
        let helper = directory + "/usr/local/lib/cinnamon-powertoys/powertoys-helper";
        let action = directory +
            "/usr/share/polkit-1/actions/io.github.geraldo-netto.cinnamon-powertoys.policy";
        Harness.equal(Harness.readFile(helper),
                      Harness.readFile(Harness.xletDir() + "/powertoys-helper"),
                      "the runtime helper path receives the shipped helper");
        Harness.equal(Harness.readFile(action),
                      Harness.readFile(Harness.testsDir() +
                          "/../polkit/io.github.geraldo-netto.cinnamon-powertoys.policy"),
                      "and the action is the shipped action");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["staged system transitions lock new package roots as directories"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-new-package-roots-XXXXXX");
    try {
        for (let target of ["install-policy", "uninstall-policy",
                            "install-rapl", "uninstall-rapl"]) {
            let root = directory + "/" + target;
            Harness.equal(GLib.file_test(root, GLib.FileTest.EXISTS), false,
                          target + " starts with no package root");
            let outcome = Harness.settle(done => Privileged._spawn(
                ["make", "-s", target, "DESTDIR=" + root],
                (status, stderr) => done({ status: status, stderr: stderr })),
            "the " + target + " target over a new package root");
            Harness.equal(outcome.status, 0,
                          target + " completes without occupying DESTDIR: " + outcome.stderr);
            Harness.equal(GLib.file_test(root, GLib.FileTest.IS_DIR), true,
                          target + " retains DESTDIR as a directory");
        }
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["policy build embeds completed catalogue translations"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-policy-i18n-XXXXXX");
    try {
        let po = directory + "/po";
        let output = directory + "/localized.policy";
        let root = Harness.testsDir() + "/..";
        GLib.mkdir_with_parents(po, 0o755);
        GLib.file_set_contents(po + "/it.po",
            'msgid ""\n' +
            'msgstr ""\n' +
            '"Project-Id-Version: Power Toys 1.0.0\\n"\n' +
            '"Language: it\\n"\n' +
            '"MIME-Version: 1.0\\n"\n' +
            '"Content-Type: text/plain; charset=UTF-8\\n"\n' +
            '"Content-Transfer-Encoding: 8bit\\n"\n' +
            '\n' +
            'msgid "Apply a power setting"\n' +
            'msgstr "Applica un’impostazione energetica"\n' +
            '\n' +
            'msgid "Authentication is required to change the CPU governor, energy performance preference, turbo boost, platform profile or battery charge limit."\n' +
            'msgstr "È richiesta l’autenticazione per modificare le impostazioni energetiche."\n');

        let outcome = Harness.settle(done => Privileged._spawn(
            ["python3", root + "/tools/build-policy.py",
             root + "/polkit/io.github.geraldo-netto.cinnamon-powertoys.policy",
             po, output],
            (status, stderr) => done({ status: status, stderr: stderr })),
        "the localized policy build");
        Harness.equal(outcome.status, 0, "the catalogue compiles: " + outcome.stderr);
        let policy = Harness.readFile(output);
        Harness.ok(policy.indexOf(
            '<description xml:lang="it">Applica un’impostazione energetica</description>') >= 0,
            "the localized action description is embedded");
        Harness.ok(policy.indexOf(
            '<message xml:lang="it">È richiesta l’autenticazione per modificare le impostazioni energetiche.</message>') >= 0,
            "the authentication prompt uses the same catalogue");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["RAPL Make targets share one transition implementation"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    Harness.ok(source.indexOf('sh "$(RAPL_TOOL)" install') >= 0,
               "install delegates the whole state change");
    Harness.ok(source.indexOf('sh "$(RAPL_TOOL)" uninstall') >= 0,
               "uninstall delegates to the same owner");
    Harness.equal((source.match(/"\$\(RAPL_LOCK\)"/g) || []).length, 2,
                  "both actions pass the same lock target");
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
             "sh", tool, action, source, destination, "adm", directory],
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

cases["RAPL uninstall waits for install publication and live replay"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-rapl-lock-XXXXXX");
    try {
        let bin = directory + "/bin";
        let rules = directory + "/rules";
        let powercap = directory + "/powercap";
        let source = directory + "/source.rules";
        let destination = rules + "/99-powertoys.rules";
        let log = directory + "/calls";
        let started = directory + "/install-reload-started";
        let runner = directory + "/run-race";
        let tool = Harness.testsDir() + "/../tools/rapl-access.sh";
        GLib.mkdir_with_parents(bin, 0o755);
        GLib.mkdir_with_parents(rules, 0o755);
        GLib.mkdir_with_parents(powercap, 0o755);
        GLib.file_set_contents(source, "GROUP=@GROUP@\n");
        GLib.file_set_contents(log, "");
        writeExecutable(bin + "/udevadm",
            "#!/bin/sh\n" +
            "printf '%s %s\\n' \"$POWERTOYS_ACTION\" \"$*\" >> \"" + log + "\"\n" +
            "if [ \"$POWERTOYS_ACTION $*\" = 'install control --reload' ]; then\n" +
            "  touch \"" + started + "\"\n" +
            "  sleep 0.2\n" +
            "fi\n");
        writeExecutable(runner,
            "#!/bin/sh\n" +
            "PATH=\"" + bin + ":$PATH\" POWERTOYS_ACTION=install " +
                "POWERTOYS_POWERCAP_ROOT=\"" + powercap + "\" DESTDIR= " +
                "sh \"" + tool + "\" install \"" + source + "\" " +
                "\"" + destination + "\" adm \"" + directory + "\" &\n" +
            "installer=$!\n" +
            "while [ ! -f \"" + started + "\" ]; do sleep 0.01; done\n" +
            "PATH=\"" + bin + ":$PATH\" POWERTOYS_ACTION=uninstall " +
                "POWERTOYS_POWERCAP_ROOT=\"" + powercap + "\" DESTDIR= " +
                "sh \"" + tool + "\" uninstall \"" + source + "\" " +
                "\"" + destination + "\" adm \"" + directory + "\" &\n" +
            "uninstaller=$!\n" +
            "wait \"$installer\"\n" +
            "wait \"$uninstaller\"\n");

        let outcome = Harness.settle(done => Privileged._spawn(
            [runner], (status, stderr) => done({ status: status, stderr: stderr })),
            "concurrent RAPL transitions");
        Harness.equal(outcome.status, 0, "both transitions complete: " + outcome.stderr);
        Harness.equal(Harness.readFile(log).trim(),
                      "install control --reload\n" +
                      "install trigger --subsystem-match=powercap\n" +
                      "uninstall control --reload\n" +
                      "uninstall trigger --subsystem-match=powercap",
                      "uninstall begins only after install finishes its live replay");
        Harness.equal(GLib.file_test(destination, GLib.FileTest.EXISTS), false,
                      "the later uninstall removes the committed rule");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
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
    Harness.ok(/periodic\s+topology\s+check\s+finds\s+them\s+within\s+one\s+minute/.test(readme),
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
