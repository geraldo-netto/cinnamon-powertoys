/* The user install is prepared beside the live applet and rolled back as one
 * operation. These cases run a private copy with a tiny applet tree and a
 * stand-in translation installer, never the user's Cinnamon directory. */

const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const UUID = "cinnamon-powertoys@geraldo-netto";

function read(path) {
    let bytes;
    try {
        let result = GLib.file_get_contents(path);
        bytes = result[1];
    } catch (error) {
        return null;
    }
    return ByteArray.toString(bytes).trim();
}

function scratch(options, body) {
    let directory = GLib.dir_make_tmp("powertoys-install-XXXXXX");
    let source = directory + "/source";
    let applet = source + "/files/" + UUID;
    let tools = source + "/tools";
    let stage = directory + "/stage";
    let parent = stage + "/share/cinnamon/applets";
    let target = parent + "/" + UUID;
    GLib.mkdir_with_parents(applet, 0o755);
    GLib.mkdir_with_parents(tools, 0o755);
    GLib.mkdir_with_parents(options.firstInstall ? parent : target, 0o755);
    try {
        GLib.file_set_contents(source + "/install.sh",
                               Harness.readFile(Harness.testsDir() + "/../install.sh"));
        GLib.chmod(source + "/install.sh", 0o700);
        /* The root-owned pair uninstall.sh can only report on. Pointed at
         * this private tree so no case depends on what is installed on the
         * machine running it; the files exist only where a case says so. */
        options.privilegedHelper = directory + "/privileged-helper";
        options.privilegedPolicy = directory + "/privileged.policy";
        if (options.privilegedPairInstalled) {
            GLib.file_set_contents(options.privilegedHelper, "helper\n");
            GLib.file_set_contents(options.privilegedPolicy, "policy\n");
        }
        GLib.file_set_contents(tools + "/uninstall.sh",
                               Harness.readFile(Harness.testsDir() + "/../tools/uninstall.sh")
                                   .replace(/^PRIVILEGED_HELPER=.*$/m,
                                            "PRIVILEGED_HELPER=\"" + options.privilegedHelper + "\"")
                                   .replace(/^PRIVILEGED_POLICY=.*$/m,
                                            "PRIVILEGED_POLICY=\"" + options.privilegedPolicy + "\""));
        GLib.file_set_contents(tools + "/deployment-lock.sh",
                               Harness.readFile(Harness.testsDir() +
                                                "/../tools/deployment-lock.sh"));
        GLib.file_set_contents(tools + "/cinnamon-xlets.sh",
                               Harness.readFile(Harness.testsDir() +
                                                "/../tools/cinnamon-xlets.sh"));

        for (let name of ["applet.js", "metadata.json", "settings-schema.json",
                          "powertoys-helper"])
            GLib.file_set_contents(applet + "/" + name, "new " + name + "\n");
        GLib.chmod(applet + "/powertoys-helper", 0o600);
        if (!options.incomplete) {
            GLib.mkdir_with_parents(applet + "/lib", 0o755);
            GLib.mkdir_with_parents(applet + "/ui", 0o755);
        }

        if (!options.firstInstall) {
            GLib.file_set_contents(target + "/marker", "old\n");
            GLib.file_set_contents(target + "/stylesheet.css", "old css\n");
        }
        GLib.file_set_contents(applet + "/stylesheet.css", "new css\n");
        let translationScript = "#!/bin/sh\n";
        if (options.translationMutation) {
            let locale = stage + "/share/locale/fr/LC_MESSAGES";
            GLib.mkdir_with_parents(locale, 0o755);
            GLib.file_set_contents(locale + "/" + UUID + ".mo", "old translation\n");
            translationScript += "mkdir -p \"$2/fr/LC_MESSAGES\"\n" +
                "printf '%s\\n' 'new translation' > \"$2/fr/LC_MESSAGES/" + UUID + ".mo\"\n";
            options.translationState = locale + "/" + UUID + ".mo";
        }
        if (options.uninstallTranslationFailure) {
            let locale = stage + "/share/locale/fr/LC_MESSAGES";
            GLib.mkdir_with_parents(locale, 0o755);
            GLib.file_set_contents(locale + "/" + UUID + ".mo", "old translation\n");
            translationScript += "if [ \"$1\" = uninstall ]; then\n" +
                "  rm -f \"$2/fr/LC_MESSAGES/" + UUID + ".mo\"\n" +
                "  exit 7\n" +
                "fi\n";
            options.uninstallTranslationState = locale + "/" + UUID + ".mo";
        }
        translationScript += "exit " + (options.translationStatus || 0) + "\n";
        GLib.file_set_contents(tools + "/install-translations.sh", translationScript);
        GLib.chmod(tools + "/install-translations.sh", 0o700);

        let path = GLib.getenv("PATH") || "/usr/bin:/bin";
        if (options.rmdirStatus || options.signalPublish || options.failedReload ||
                options.mismatchedReload || options.evalRefused ||
                options.runningQueryFailure ||
                options.uninstallRuntime || options.uninstallQueryFailure ||
                options.uninstallThemeFailure) {
            let bin = directory + "/bin";
            GLib.mkdir_with_parents(bin, 0o755);
            if (options.rmdirStatus) {
                GLib.file_set_contents(bin + "/rmdir",
                                       "#!/bin/sh\nexit " + options.rmdirStatus + "\n");
                GLib.chmod(bin + "/rmdir", 0o700);
            }
            if (options.signalPublish) {
                GLib.file_set_contents(bin + "/mv",
                    "#!/bin/sh\n/bin/mv \"$@\"\nkill -TERM \"$PPID\"\n");
                GLib.chmod(bin + "/mv", 0o700);
            }
            if (options.failedReload || options.mismatchedReload) {
                let state = directory + "/reload-count";
                let themeState = directory + "/theme-count";
                GLib.file_set_contents(state, "0\n");
                GLib.file_set_contents(themeState, "0\n");
                GLib.file_set_contents(bin + "/gdbus",
                    "#!/bin/sh\n" +
                    "case \"$*\" in\n" +
                    "  *GetRunningXletUUIDs*)\n" +
                    "    echo \"(['" + UUID + "'],)\";;\n" +
                    "  *ReloadXlet*)\n" +
                    "    count=$(cat '" + state + "')\n" +
                    "    echo $((count + 1)) > '" + state + "';;\n" +
                    "  *_changeTheme*)\n" +
                    "    themes=$(cat '" + themeState + "')\n" +
                    "    echo $((themes + 1)) > '" + themeState + "'\n" +
                    "    echo \"(true, '')\";;\n" +
                    "  *Eval*)\n" +
                    "    count=$(cat '" + state + "')\n" +
                    "    if [ \"$count\" = 1 ]; then\n" +
                    (options.failedReload
                        ? "      echo \"(true, 'null')\"\n"
                        : "      echo \"(true, '\\\"/opt/other/" + UUID + "\\\"')\"\n") +
                    "    else echo \"(true, '\\\"" + target + "\\\"')\"; fi;;\n" +
                    "esac\n");
                GLib.chmod(bin + "/gdbus", 0o700);
                options.themeState = themeState;
            }
            /* A stock session: org.Cinnamon.Eval is refused because the
             * development-tools key is off, and answers so with a complete
             * (false, '') reply. Everything Eval-free still works. */
            if (options.evalRefused) {
                let state = directory + "/reload-count";
                GLib.file_set_contents(state, "0\n");
                GLib.file_set_contents(bin + "/gdbus",
                    "#!/bin/sh\n" +
                    "case \"$*\" in\n" +
                    "  *GetRunningXletUUIDs*)\n" +
                    (options.reloadLosesApplet
                        ? "    count=$(cat '" + state + "')\n" +
                          "    if [ \"$count\" = 0 ]; then echo \"(['" + UUID + "'],)\";\n" +
                          "    else echo '(@as [],)'; fi;;\n"
                        : "    echo \"(['" + UUID + "'],)\";;\n") +
                    "  *ReloadXlet*)\n" +
                    "    count=$(cat '" + state + "')\n" +
                    "    echo $((count + 1)) > '" + state + "';;\n" +
                    "  *Eval*)\n" +
                    "    echo \"(false, '')\";;\n" +
                    "esac\n");
                GLib.chmod(bin + "/gdbus", 0o700);
                options.reloadState = state;
            }
            if (options.runningQueryFailure) {
                GLib.file_set_contents(bin + "/gdbus", "#!/bin/sh\nexit 23\n");
                GLib.chmod(bin + "/gdbus", 0o700);
            }
            if (options.uninstallRuntime) {
                let disabled = directory + "/disabled";
                let settings = directory + "/enabled-applets";
                let themeState = directory + "/uninstall-theme-count";
                let activePath = options.uninstallActivePath || target;
                GLib.file_set_contents(themeState, "0\n");
                GLib.file_set_contents(bin + "/gsettings",
                    "#!/bin/sh\n" +
                    "if [ \"$1\" = get ]; then\n" +
                    "  echo \"['panel1:left:0:" + UUID + ":7', 'panel1:right:0:menu@cinnamon.org:8']\"\n" +
                    "else printf '%s' \"$4\" > '" + settings + "'; touch '" + disabled + "'; fi\n");
                GLib.chmod(bin + "/gsettings", 0o700);
                GLib.file_set_contents(bin + "/gdbus",
                    "#!/bin/sh\n" +
                    "case \"$*\" in\n" +
                    "  *_changeTheme*)\n" +
                    "    themes=$(cat '" + themeState + "')\n" +
                    "    echo $((themes + 1)) > '" + themeState + "'\n" +
                    (options.uninstallThemeFailure
                        ? "    echo \"(false, 'debugging disabled')\";;\n"
                        : "    echo \"(true, '')\";;\n") +
                    (options.uninstallEvalRefused
                        ? "  *Eval*) echo \"(false, '')\";;\n"
                        : "  *Eval*) echo \"(true, '\\\"" + activePath + "\\\"')\";;\n") +
                    "  *GetRunningXletUUIDs*)\n" +
                    (options.uninstallNotRunning ?
                        "    echo '(@as [],)' ;;\n" :
                        "    if [ -f '" + disabled + "' ]; then echo '(@as [],)';\n" +
                        "    else echo \"(['" + UUID + "'],)\"; fi;;\n") +
                    "esac\n");
                GLib.chmod(bin + "/gdbus", 0o700);
                options.enabledState = settings;
                options.uninstallThemeState = themeState;
            }
            if (options.uninstallQueryFailure) {
                GLib.file_set_contents(bin + "/gdbus", "#!/bin/sh\nexit 23\n");
                GLib.chmod(bin + "/gdbus", 0o700);
            }
            path = bin + ":" + path;
        }

        return body({ directory: directory, source: source, stage: stage,
                      parent: parent, target: target, path: path });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function install(tree, live) {
    let environment = ["env", "PATH=" + tree.path];
    if (live)
        environment.push("PREFIX=" + tree.stage + "/share");
    else
        environment.push("DESTDIR=" + tree.stage, "PREFIX=/share");
    environment.push(tree.source + "/install.sh");
    return Harness.settle(done => Privileged._spawn(
        environment, (status, stderr, stdout) => done({
            status: status, stderr: stderr, stdout: stdout || "" })),
    live ? "the live install" : "the staged install");
}

function temporaryEntries(tree) {
    let entries = [];
    let directory = imports.gi.Gio.File.new_for_path(tree.parent);
    let enumerator = directory.enumerate_children("standard::name",
        imports.gi.Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        let name = info.get_name();
        if (name.indexOf("." + UUID + ".") === 0 &&
                name !== "." + UUID + ".deployment.lock")
            entries.push(name);
    }
    enumerator.close(null);
    return entries;
}

function uninstall(tree, live) {
    let environment = ["env", "PATH=" + tree.path];
    if (live)
        environment.push("PREFIX=" + tree.stage + "/share");
    else
        environment.push("DESTDIR=" + tree.stage, "PREFIX=/share");
    environment.push("sh", tree.source + "/tools/uninstall.sh");
    return Harness.settle(done => Privileged._spawn(
        environment, (status, stderr, stdout) => done({
            status: status, stderr: stderr, stdout: stdout || "" })),
    live ? "the live uninstall" : "the staged uninstall");
}

var cases = {};

cases["deployment transactions exclude only the same target"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-lock-XXXXXX");
    try {
        let tool = Harness.testsDir() + "/../tools/deployment-lock.sh";
        let target = directory + "/share/cinnamon/applets/" + UUID;
        let ready = directory + "/ready";
        let script = [
            "set -eu",
            "UUID=" + UUID,
            ". \"$1\"",
            "target=$2",
            "ready=$3",
            "( acquire_deployment_lock \"$target\"; : > \"$ready\"; sleep 1 ) &",
            "holder=$!",
            "attempts=0",
            "while [ ! -f \"$ready\" ] && [ \"$attempts\" -lt 100 ]; do",
            "  attempts=$((attempts + 1)); sleep 0.01",
            "done",
            "[ -f \"$ready\" ]",
            "if ( acquire_deployment_lock \"$target\" ); then exit 7; fi",
            "( acquire_deployment_lock \"$target.other\" )",
            "wait \"$holder\"",
        ].join("\n");
        let outcome = Harness.settle(done => Privileged._spawn(
            ["sh", "-c", script, "lock-test", tool, target, ready],
            (status, stderr) => done({ status: status, stderr: stderr })),
        "deployment lock contention");
        Harness.equal(outcome.status, 0,
                      "the same target was refused while an independent target proceeded");
        Harness.ok(outcome.stderr.indexOf("another deployment operation owns") >= 0,
                   "contention fails with an actionable diagnostic: " + outcome.stderr);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["every applet asset publisher acquires the deployment lock"] = function () {
    let root = Harness.testsDir() + "/..";
    for (let relative of ["install.sh", "tools/uninstall.sh",
                           "tools/install-translations.sh"]) {
        let source = Harness.readFile(root + "/" + relative);
        Harness.ok(source.indexOf("deployment-lock.sh") >= 0,
                   relative + " sources the shared lock");
        Harness.ok(source.indexOf("acquire_deployment_lock") >= 0,
                   relative + " acquires it before mutation");
    }
};

cases["install and uninstall share exact running UUID membership"] = function () {
    let root = Harness.testsDir() + "/..";
    for (let relative of ["install.sh", "tools/uninstall.sh"]) {
        let source = Harness.readFile(root + "/" + relative);
        Harness.ok(source.indexOf("cinnamon-xlets.sh") >= 0,
                   relative + " sources the shared Cinnamon query");
        Harness.ok(source.indexOf('grep -Fq "$UUID"') < 0,
                   relative + " does not search serialized output by substring");
    }
};

cases["running xlet membership compares decoded array elements"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-running-xlets-XXXXXX");
    try {
        let bin = directory + "/bin";
        let gdbus = bin + "/gdbus";
        let tool = Harness.testsDir() + "/../tools/cinnamon-xlets.sh";
        GLib.mkdir_with_parents(bin, 0o755);

        function query(reply) {
            GLib.file_set_contents(
                gdbus, "#!/bin/sh\nprintf '%s\\n' \"" + reply + "\"\n");
            GLib.chmod(gdbus, 0o700);
            return Harness.settle(done => Privileged._spawn(
                ["env", "PATH=" + bin + ":" + (GLib.getenv("PATH") || "/usr/bin:/bin"),
                 "sh", "-c", '. "$1"; cinnamon_xlet_running "$2"',
                 "running-xlet-test", tool, UUID],
                (status, stderr) => done({ status: status, stderr: stderr })),
            "the decoded running-xlet query");
        }

        Harness.equal(query("(['prefix-" + UUID + "-suffix'],)").status, 1,
                      "a UUID that merely contains the target is not a match");
        Harness.equal(query("(['menu@cinnamon.org', '" + UUID + "'],)").status, 0,
                      "the exact array member is a match");
        Harness.equal(query("(@as [],)").status, 1,
                      "the annotated empty GVariant is a valid absent answer");
        Harness.equal(query("not a variant").status, 2,
                      "malformed serialized state is an observation failure");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["live xlet paths require an instantiated applet answer"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-live-xlet-XXXXXX");
    try {
        let bin = directory + "/bin";
        let gdbus = bin + "/gdbus";
        let tool = Harness.testsDir() + "/../tools/cinnamon-xlets.sh";
        GLib.mkdir_with_parents(bin, 0o755);

        function query(reply) {
            GLib.file_set_contents(gdbus,
                                   "#!/bin/sh\nprintf '%s\\n' \"$POWERTOYS_TEST_REPLY\"\n");
            GLib.chmod(gdbus, 0o700);
            return Harness.settle(done => Privileged._spawn(
                ["env", "POWERTOYS_TEST_REPLY=" + reply,
                 "PATH=" + bin + ":" + (GLib.getenv("PATH") || "/usr/bin:/bin"),
                 "sh", "-c", '. "$1"; cinnamon_xlet_live_path "$2"',
                 "live-xlet-test", tool, UUID],
                (status, stderr, stdout) => done({
                    status: status,
                    stderr: stderr,
                    stdout: stdout.trim(),
                })), "the live xlet source query");
        }

        let path = query("(true, '\"/tmp/powertoys/../live-xlet\"')");
        Harness.equal(path.status, 0, "an instantiated applet path is present");
        Harness.equal(path.stdout, "/tmp/live-xlet", "the loaded source path is normalized");
        let absent = query("(true, 'null')");
        Harness.equal(absent.status, 1,
                      "a null applet definition is valid absence: " +
                      absent.stdout + " " + absent.stderr);
        Harness.equal(query("(true, '42')").status, 2,
                      "a non-path Eval result is an observation failure");
        Harness.equal(query("(false, '\"failed\"')").status, 3,
                      "a refusal cannot prove a live instance, but is a complete answer");
        Harness.equal(query("(false, '')").status, 3,
                      "which is exactly what a session with development-tools off replies");
        Harness.equal(query("nonsense").status, 2,
                      "an unparseable reply remains an observation failure");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["an incomplete staged applet leaves the live install untouched"] = function () {
    scratch({ incomplete: true }, tree => {
        let outcome = install(tree);
        Harness.ok(outcome.status !== 0, "validation refused the copy");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior applet is still live");
        Harness.deepEqual(temporaryEntries(tree), [], "the private copy was cleaned up");
    });
};

cases["a failure after the swap restores the previous applet"] = function () {
    scratch({ translationStatus: 7 }, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 7, "the later failure is preserved");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior tree was restored");
        Harness.equal(read(tree.target + "/applet.js"), null, "the replacement was removed");
        Harness.deepEqual(temporaryEntries(tree), [], "neither staging nor backup was stranded");
    });
};

cases["a failed running-state query leaves an upgrade untouched"] = function () {
    scratch({ runningQueryFailure: true }, tree => {
        let outcome = install(tree, true);
        Harness.ok(outcome.status !== 0, "the unknown prior state aborts the upgrade");
        Harness.equal(read(tree.target + "/marker"), "old", "the existing applet was not moved");
        Harness.equal(read(tree.target + "/applet.js"), null, "the replacement was not published");
        Harness.ok(outcome.stderr.indexOf("could not determine whether") >= 0,
                   "the observation failure is explicit: " + outcome.stderr);
        Harness.deepEqual(temporaryEntries(tree), [], "the unused staging tree was removed");
    });
};

cases["an unreachable Cinnamon session does not block a first install"] = function () {
    scratch({ firstInstall: true, runningQueryFailure: true }, tree => {
        let outcome = install(tree, true);
        Harness.equal(outcome.status, 0,
                      "an absent target needs no live-state observation: " + outcome.stderr);
        Harness.equal(read(tree.target + "/applet.js"), "new applet.js",
                      "the first applet tree was published");
        Harness.deepEqual(temporaryEntries(tree), [],
                          "the completed first install left no transaction tree");
    });
};

cases["a failed backup reservation cannot replace the live applet"] = function () {
    scratch({ rmdirStatus: 9 }, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 9, "the reservation failure is preserved");
        Harness.equal(read(tree.target + "/marker"), "old", "the live tree was never moved");
        Harness.equal(read(tree.target + "/applet.js"), null, "an empty backup was not restored");
        Harness.deepEqual(temporaryEntries(tree), [], "the failed reservation was cleaned up");
    });
};

cases["a complete staged applet replaces the previous tree"] = function () {
    let options = { translationMutation: true };
    scratch(options, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 0, "the install completed");
        Harness.equal(read(tree.target + "/applet.js"), "new applet.js", "the new tree is live");
        Harness.equal(read(tree.target + "/marker"), null, "the old tree was retired");
        Harness.equal(GLib.file_test(tree.target + "/powertoys-helper",
                                    GLib.FileTest.IS_EXECUTABLE), true,
                      "the helper was validated and made executable before the swap");
        Harness.equal(read(options.translationState), "new translation",
                      "the new catalogue is retained after commit");
        Harness.deepEqual(temporaryEntries(tree), [], "the backup was removed after commit");
    });
};

cases["a first-install publish cannot be interrupted before it is recorded"] = function () {
    scratch({ firstInstall: true, signalPublish: true }, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 0,
                      "the signal in the protected publish transition is ignored");
        Harness.equal(read(tree.target + "/applet.js"), "new applet.js",
                      "the fully completed first install remains visible");
        Harness.deepEqual(temporaryEntries(tree), [], "no transaction tree is stranded");
    });
};

cases["a failed live reload restores and reactivates the previous applet"] = function () {
    let options = { failedReload: true, translationMutation: true };
    scratch(options, tree => {
        let outcome = install(tree, true);
        Harness.ok(outcome.status !== 0, "a missing replacement instance fails the upgrade");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior tree was restored");
        Harness.equal(read(tree.target + "/applet.js"), null, "the broken replacement was removed");
        Harness.ok(outcome.stderr.indexOf("Restored and reloaded") >= 0,
                   "the prior runtime was reactivated: " + outcome.stderr);
        Harness.equal(read(options.translationState), "old translation",
                      "the previous catalogue was restored before reactivation");
        Harness.equal(read(options.themeState), "2",
                      "the theme was loaded once forward and once after CSS rollback");
        Harness.deepEqual(temporaryEntries(tree), [], "the rollback left no private trees");
    });
};

cases["a reload from another source restores the previous applet"] = function () {
    let options = { mismatchedReload: true };
    scratch(options, tree => {
        let outcome = install(tree, true);
        Harness.ok(outcome.status !== 0, "a foreign replacement source fails the upgrade");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior tree was restored");
        Harness.equal(read(tree.target + "/applet.js"), null,
                      "the replacement loaded elsewhere was removed");
        Harness.ok(outcome.stderr.indexOf("Restored and reloaded") >= 0,
                   "the restored target is reactivated: " + outcome.stderr);
    });
};

cases["a live uninstall disables the applet before deleting it"] = function () {
    let options = { uninstallRuntime: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0,
                      "the coordinated uninstall completed: " + outcome.stderr);
        Harness.equal(GLib.file_test(tree.target, GLib.FileTest.EXISTS), false,
                      "the source was removed after the runtime disappeared");
        let enabled = read(options.enabledState);
        Harness.equal(enabled.indexOf(UUID), -1, "the stale panel entry was removed");
        Harness.ok(enabled.indexOf("menu@cinnamon.org") >= 0, "other applets were preserved");
        Harness.equal(read(options.uninstallThemeState), "1",
                      "the committed removal reloads the retained stylesheet once");
    });
};

cases["a refused uninstall theme reload reports the restart requirement"] = function () {
    let options = { uninstallRuntime: true, uninstallThemeFailure: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0, "theme access cannot undo a committed removal");
        Harness.equal(GLib.file_test(tree.target, GLib.FileTest.EXISTS), false,
                      "the applet remains removed");
        Harness.equal(read(options.uninstallThemeState), "1",
                      "the guarded theme reload was attempted once");
        Harness.ok(outcome.stderr.indexOf("may remain active until Cinnamon is restarted") >= 0,
                   "the retained stylesheet has an actionable warning: " + outcome.stderr);
    });
};

cases["a prefix cannot disable the same UUID running from another source"] = function () {
    let options = {
        firstInstall: true,
        uninstallRuntime: true,
        uninstallActivePath: "/opt/other/share/cinnamon/applets/" + UUID,
    };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.ok(outcome.status !== 0, "the mismatched active source aborts the uninstall");
        Harness.equal(read(options.enabledState), null,
                      "the foreign applet's panel setting was not changed");
        Harness.ok(outcome.stderr.indexOf("is running from /opt/other/") >= 0,
                   "the mismatch names the protected source: " + outcome.stderr);
    });
};

cases["a stale panel entry is removed when no applet copy is running"] = function () {
    let options = { firstInstall: true, uninstallRuntime: true, uninstallNotRunning: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0, "stale cleanup does not require installed source");
        Harness.equal(read(options.enabledState).indexOf(UUID), -1,
                      "the stale UUID was removed from the panel setting");
    });
};

cases["an uninstall observation failure changes nothing"] = function () {
    let options = { uninstallRuntime: true, uninstallQueryFailure: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.ok(outcome.status !== 0, "an unknown live state aborts the uninstall");
        Harness.equal(read(tree.target + "/marker"), "old", "the source remains installed");
        Harness.equal(read(options.enabledState), null, "the panel setting was never changed");
        Harness.ok(outcome.stderr.indexOf("could not determine whether") >= 0,
                   "the observation failure is explicit: " + outcome.stderr);
    });
};

cases["a failed uninstall restores assets before the panel setting"] = function () {
    let options = { uninstallRuntime: true, uninstallTranslationFailure: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 7,
                      "the translation failure is preserved: " + outcome.stderr);
        Harness.equal(read(tree.target + "/marker"), "old", "the source tree was restored");
        Harness.equal(read(options.uninstallTranslationState), "old translation",
                      "the removed catalogue was restored");
        Harness.ok(read(options.enabledState).indexOf(UUID) >= 0,
                   "the original enabled-applets value was restored after the assets");
        Harness.deepEqual(temporaryEntries(tree), [], "the source backup was not stranded");
    });
};

/* org.Cinnamon.Eval is refused unless the development-tools gsettings key is
 * on, which it is not on a stock session. Reading a live applet's source
 * directory is the only thing that needs it, so a refusal must cost the
 * verification and nothing else. It used to cost the whole upgrade. */
cases["an upgrade completes on a session that refuses Eval"] = function () {
    let options = { evalRefused: true, translationMutation: true };
    scratch(options, tree => {
        let outcome = install(tree, true);
        Harness.equal(outcome.status, 0,
                      "a refused Eval is not a failed reload: " + outcome.stderr);
        Harness.equal(read(tree.target + "/applet.js"), "new applet.js",
                      "the replacement stayed published");
        Harness.equal(read(tree.target + "/marker"), null, "the old tree was retired");
        Harness.equal(read(options.reloadState), "1", "the applet was reloaded once");
        Harness.ok(outcome.stderr.indexOf("restoring the previous applet") < 0,
                   "nothing was rolled back: " + outcome.stderr);
        Harness.equal(read(options.translationState), "new translation",
                      "and the new catalogue was kept");
    });
};

cases["a refused Eval says the source could not be checked"] = function () {
    scratch({ evalRefused: true }, tree => {
        let outcome = install(tree, true);
        Harness.equal(outcome.status, 0, "the upgrade succeeded");
        Harness.ok(outcome.stdout.indexOf("development-tools") >= 0,
                   "the unverified source is stated rather than silently assumed: " +
                   outcome.stdout);
        Harness.ok(outcome.stdout.indexOf("Reloaded the running applet") >= 0,
                   "alongside what did happen: " + outcome.stdout);
    });
};

cases["a refused Eval still requires the applet to be loaded"] = function () {
    scratch({ evalRefused: true, reloadLosesApplet: true }, tree => {
        let outcome = install(tree, true);
        Harness.ok(outcome.status !== 0,
                   "an applet that is not running after the reload still fails the upgrade");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior tree was restored");
        Harness.equal(read(tree.target + "/applet.js"), null,
                      "the replacement that did not start was removed");
    });
};

cases["a live uninstall proceeds when Eval is refused"] = function () {
    let options = {
        uninstallRuntime: true,
        uninstallEvalRefused: true,
        uninstallThemeFailure: true,
    };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0,
                      "a refused Eval no longer blocks removing a running applet: " +
                      outcome.stderr);
        Harness.equal(GLib.file_test(tree.target, GLib.FileTest.EXISTS), false,
                      "the applet was removed");
        Harness.equal(read(options.enabledState).indexOf(UUID), -1,
                      "and its panel entry with it");
        Harness.ok(outcome.stderr.indexOf("could not check where the running") >= 0,
                   "the unverified source is stated: " + outcome.stderr);
    });
};

cases["an uninstall names the privileged pair it cannot remove"] = function () {
    let options = { uninstallRuntime: true, privilegedPairInstalled: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0, "the uninstall completed: " + outcome.stderr);
        Harness.ok(outcome.stdout.indexOf(options.privilegedHelper) >= 0,
                   "the root-owned helper that is still installed is named");
        Harness.ok(outcome.stdout.indexOf(options.privilegedPolicy) >= 0,
                   "and so is the polkit action that names it");
        Harness.ok(outcome.stdout.indexOf("sudo make uninstall-policy") >= 0,
                   "with the one command that removes them");
    });
};

cases["an uninstall with no privileged pair installed says nothing about one"] = function () {
    let options = { uninstallRuntime: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0, "the uninstall completed: " + outcome.stderr);
        Harness.equal(outcome.stdout.indexOf("uninstall-policy"), -1,
                      "nothing is said about a pair that is not there");
    });
};

cases["a staged uninstall says nothing about the running system"] = function () {
    /* A package manager works on a filesystem image; what is installed on the
     * machine building it is none of its business. */
    let options = { privilegedPairInstalled: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, false);
        Harness.equal(outcome.status, 0, "the staged uninstall completed: " + outcome.stderr);
        Harness.equal(outcome.stdout.indexOf("uninstall-policy"), -1,
                      "a staged removal reports nothing about this machine");
    });
};
