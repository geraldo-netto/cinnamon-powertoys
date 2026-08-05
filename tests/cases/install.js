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
    let applet = source + "/" + UUID;
    let tools = source + "/tools";
    let stage = directory + "/stage";
    let parent = stage + "/share/cinnamon/applets";
    let target = parent + "/" + UUID;
    GLib.mkdir_with_parents(applet, 0o755);
    GLib.mkdir_with_parents(tools, 0o755);
    GLib.mkdir_with_parents(target, 0o755);
    try {
        GLib.file_set_contents(source + "/install.sh",
                               Harness.readFile(Harness.testsDir() + "/../install.sh"));
        GLib.chmod(source + "/install.sh", 0o700);
        GLib.file_set_contents(tools + "/uninstall.sh",
                               Harness.readFile(Harness.testsDir() + "/../tools/uninstall.sh"));

        for (let name of ["applet.js", "metadata.json", "settings-schema.json",
                          "powertoys-helper"])
            GLib.file_set_contents(applet + "/" + name, "new " + name + "\n");
        GLib.chmod(applet + "/powertoys-helper", 0o600);
        if (!options.incomplete)
            GLib.mkdir_with_parents(applet + "/lib", 0o755);

        GLib.file_set_contents(target + "/marker", "old\n");
        GLib.file_set_contents(target + "/stylesheet.css", "old css\n");
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
        translationScript += "exit " + (options.translationStatus || 0) + "\n";
        GLib.file_set_contents(tools + "/install-translations.sh", translationScript);
        GLib.chmod(tools + "/install-translations.sh", 0o700);

        let path = GLib.getenv("PATH") || "/usr/bin:/bin";
        if (options.rmdirStatus || options.failedReload || options.runningQueryFailure ||
                options.uninstallRuntime) {
            let bin = directory + "/bin";
            GLib.mkdir_with_parents(bin, 0o755);
            if (options.rmdirStatus) {
                GLib.file_set_contents(bin + "/rmdir",
                                       "#!/bin/sh\nexit " + options.rmdirStatus + "\n");
                GLib.chmod(bin + "/rmdir", 0o700);
            }
            if (options.failedReload) {
                let state = directory + "/reload-count";
                let themeState = directory + "/theme-count";
                GLib.file_set_contents(state, "0\n");
                GLib.file_set_contents(themeState, "0\n");
                GLib.file_set_contents(bin + "/gdbus",
                    "#!/bin/sh\n" +
                    "case \"$*\" in\n" +
                    "  *GetRunningXletUUIDs*)\n" +
                    "    count=$(cat '" + state + "')\n" +
                    "    if [ \"$count\" = 1 ]; then echo '(@as [],)';\n" +
                    "    else echo \"(['" + UUID + "'],)\"; fi;;\n" +
                    "  *ReloadXlet*)\n" +
                    "    count=$(cat '" + state + "')\n" +
                    "    echo $((count + 1)) > '" + state + "';;\n" +
                    "  *Eval*)\n" +
                    "    themes=$(cat '" + themeState + "')\n" +
                    "    echo $((themes + 1)) > '" + themeState + "'\n" +
                    "    echo \"(true, '')\";;\n" +
                    "esac\n");
                GLib.chmod(bin + "/gdbus", 0o700);
                options.themeState = themeState;
            }
            if (options.runningQueryFailure) {
                GLib.file_set_contents(bin + "/gdbus", "#!/bin/sh\nexit 23\n");
                GLib.chmod(bin + "/gdbus", 0o700);
            }
            if (options.uninstallRuntime) {
                let disabled = directory + "/disabled";
                let settings = directory + "/enabled-applets";
                GLib.file_set_contents(bin + "/gsettings",
                    "#!/bin/sh\n" +
                    "if [ \"$1\" = get ]; then\n" +
                    "  echo \"['panel1:left:0:" + UUID + ":7', 'panel1:right:0:menu@cinnamon.org:8']\"\n" +
                    "else printf '%s' \"$4\" > '" + settings + "'; touch '" + disabled + "'; fi\n");
                GLib.chmod(bin + "/gsettings", 0o700);
                GLib.file_set_contents(bin + "/gdbus",
                    "#!/bin/sh\n" +
                    "if [ -f '" + disabled + "' ]; then echo '(@as [],)';\n" +
                    "else echo \"(['" + UUID + "'],)\"; fi\n");
                GLib.chmod(bin + "/gdbus", 0o700);
                options.enabledState = settings;
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
        environment, (status, stderr) => done({ status: status, stderr: stderr })),
    live ? "the live install" : "the staged install");
}

function temporaryEntries(tree) {
    let entries = [];
    let directory = imports.gi.Gio.File.new_for_path(tree.parent);
    let enumerator = directory.enumerate_children("standard::name",
        imports.gi.Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_name().indexOf("." + UUID + ".") === 0)
            entries.push(info.get_name());
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
        environment, (status, stderr) => done({ status: status, stderr: stderr })),
    live ? "the live uninstall" : "the staged uninstall");
}

var cases = {};

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

cases["a live uninstall disables the applet before deleting it"] = function () {
    let options = { uninstallRuntime: true };
    scratch(options, tree => {
        let outcome = uninstall(tree, true);
        Harness.equal(outcome.status, 0, "the coordinated uninstall completed");
        Harness.equal(GLib.file_test(tree.target, GLib.FileTest.EXISTS), false,
                      "the source was removed after the runtime disappeared");
        let enabled = read(options.enabledState);
        Harness.equal(enabled.indexOf(UUID), -1, "the stale panel entry was removed");
        Harness.ok(enabled.indexOf("menu@cinnamon.org") >= 0, "other applets were preserved");
    });
};
