/*
 * Translation.
 *
 * Thirty lines, and the part worth pinning is not the lookup - it is the two
 * agreements the lookup depends on, both of which are between this file and
 * something outside it.
 *
 * The domain is the applet's uuid, which Cinnamon hands the module and which
 * is also the name the install script compiles its catalogues under. The
 * directory is the one the install script writes to. Neither is written down
 * twice on purpose, and both would fail the same way if they came apart: every
 * string in the applet silently untranslated, on a machine where the
 * translation is installed and correct.
 *
 * The lookup itself falls back to the shell's own catalogue, which cannot be
 * exercised here: it would need a compiled catalogue installed for this domain
 * and a locale to read it in, and the build machine has neither. What can be
 * held to is that it answers, and that what it answers is the text.
 */

const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Translate = Harness.requireXlet("./lib/gettext.js");

var cases = {};

function installedTree(msgfmt, body) {
    let directory = GLib.dir_make_tmp("powertoys-gettext-XXXXXX");
    let tools = directory + "/tools";
    let po = directory + "/" + Harness.UUID + "/po";
    let locale = directory + "/locale";
    let bin = directory + "/bin";
    GLib.mkdir_with_parents(tools, 0o755);
    GLib.mkdir_with_parents(po, 0o755);
    GLib.mkdir_with_parents(bin, 0o755);
    try {
        let script = tools + "/install-translations.sh";
        GLib.file_set_contents(script,
            Harness.readFile(Harness.testsDir() + "/../tools/install-translations.sh"));
        GLib.chmod(script, 0o700);
        GLib.file_set_contents(bin + "/msgfmt", "#!/bin/sh\n" + msgfmt + "\n");
        GLib.chmod(bin + "/msgfmt", 0o700);
        return body({ directory: directory, script: script, po: po,
                      locale: locale, bin: bin });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function write(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, value + "\n");
}

function read(path) {
    try {
        let result = GLib.file_get_contents(path);
        return ByteArray.toString(result[1]).trim();
    } catch (error) {
        return null;
    }
}

function install(tree) {
    return installResult(tree).status;
}

function installResult(tree) {
    return actionResult(tree, "install");
}

function actionResult(tree, action) {
    let environment = GLib.get_environ();
    environment = GLib.environ_setenv(environment, "PATH",
        tree.bin + ":" + (GLib.getenv("PATH") || ""), true);
    let result = GLib.spawn_sync(null, [tree.script, action, tree.locale],
                                 environment, GLib.SpawnFlags.NONE, null);
    return {
        status: result[3],
        stdout: ByteArray.toString(result[1] || []),
        stderr: ByteArray.toString(result[2] || []),
    };
}

cases["the domain is the applet's own uuid"] = function () {
    /* Cinnamon hands every xlet file its own metadata, so nothing here is
     * written out - which is the point: an applet renamed keeps working. */
    Harness.equal(Translate.UUID, "cinnamon-powertoys@geraldo-netto",
                  "the uuid the harness loaded it as");
};

cases["an installed applet binds catalogues beside its data root"] = function () {
    /*
     * A custom PREFIX is visible at runtime through the applet path. Walking
     * back from Cinnamon's fixed applet suffix reaches the same data root the
     * install script used, instead of silently falling back to the user's
     * locale directory.
     */
    Harness.equal(Translate.localeDirectory(
                      "/opt/powertoys/share/cinnamon/applets/" + Harness.UUID),
                  "/opt/powertoys/share/locale", "a custom prefix");
    Harness.equal(Translate.localeDirectory(
                      "/usr/share/cinnamon/applets/" + Harness.UUID + "/"),
                  "/usr/share/locale", "a system prefix with a trailing slash");
    Harness.equal(Translate.localeDirectory("/a/source/checkout"),
                  GLib.get_user_data_dir() + "/locale", "a development fallback");

    let script = Harness.readFile(Harness.testsDir() + "/../tools/install-translations.sh");
    Harness.ok(script.indexOf('LOCALE_DIR=${2:-') >= 0,
               "the install script accepts the locale root for the chosen prefix");
    Harness.ok(script.indexOf('$UUID.mo') >= 0,
               "and still names the catalogue after the uuid this binds as");
};

cases["an upgrade prunes only obsolete catalogues from this domain"] = function () {
    installedTree('[ "$1" = -o ] && cp "$3" "$2"', tree => {
        write(tree.po + "/fr.po", "new french catalogue");
        let old = tree.locale + "/en/LC_MESSAGES/" + Harness.UUID + ".mo";
        let other = tree.locale + "/en/LC_MESSAGES/another-application.mo";
        let current = tree.locale + "/fr/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(old, "obsolete");
        write(other, "keep me");
        write(current, "old french catalogue");

        Harness.equal(install(tree), 0, "the translation install succeeded");
        Harness.equal(read(old), null, "a language no longer in po/ was removed");
        Harness.equal(read(other), "keep me", "another gettext domain was untouched");
        Harness.equal(read(current), "new french catalogue", "the current language was replaced");
    });
};

cases["a failed translation update does not prune old catalogues"] = function () {
    installedTree("exit 1", tree => {
        write(tree.po + "/fr.po", "broken catalogue");
        let old = tree.locale + "/en/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(old, "still installed");

        Harness.ok(install(tree) !== 0, "the compile failure reaches the installer");
        Harness.equal(read(old), "still installed",
                      "pruning waits until the current set compiled successfully");
    });
};

cases["all translations compile before any are published"] = function () {
    installedTree('case "$3" in *de.po) exit 1 ;; *) cp "$3" "$2" ;; esac', tree => {
        write(tree.po + "/fr.po", "new french catalogue");
        write(tree.po + "/de.po", "broken german catalogue");
        let french = tree.locale + "/fr/LC_MESSAGES/" + Harness.UUID + ".mo";
        let obsolete = tree.locale + "/en/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(french, "old french catalogue");
        write(obsolete, "old english catalogue");

        Harness.ok(install(tree) !== 0, "one broken source fails the set");
        Harness.equal(read(french), "old french catalogue",
                      "a language compiled earlier was never published");
        Harness.equal(read(obsolete), "old english catalogue",
                      "and pruning did not begin");
    });
};

cases["a publication failure restores every prior catalogue"] = function () {
    installedTree('[ "$1" = -o ] && cp "$3" "$2"', tree => {
        write(tree.po + "/de.po", "new german catalogue");
        write(tree.po + "/fr.po", "new french catalogue");
        let german = tree.locale + "/de/LC_MESSAGES/" + Harness.UUID + ".mo";
        let french = tree.locale + "/fr/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(german, "old german catalogue");
        write(french, "old french catalogue");

        let move = tree.bin + "/mv";
        GLib.file_set_contents(move, [
            "#!/bin/sh",
            "case \"$*\" in *'/fr/LC_MESSAGES/'*) exit 9 ;; esac",
            "exec /usr/bin/mv \"$@\"",
            "",
        ].join("\n"));
        GLib.chmod(move, 0o700);

        Harness.ok(install(tree) !== 0, "the failed atomic rename reaches the parent");
        Harness.equal(read(german), "old german catalogue",
                      "the language published first was rolled back");
        Harness.equal(read(french), "old french catalogue",
                      "the failed language kept its prior version too");
    });
};

cases["a failed translation rollback retains its recovery backup"] = function () {
    installedTree('[ "$1" = -o ] && cp "$3" "$2"', tree => {
        write(tree.po + "/fr.po", "new french catalogue");
        let french = tree.locale + "/fr/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(french, "old french catalogue");

        let move = tree.bin + "/mv";
        GLib.file_set_contents(move, "#!/bin/sh\nexit 9\n");
        GLib.chmod(move, 0o700);

        let copy = tree.bin + "/cp";
        GLib.file_set_contents(copy, [
            "#!/bin/sh",
            "case \"$3\" in *'.backup.'*) exit 8 ;; esac",
            "exec /usr/bin/cp \"$@\"",
            "",
        ].join("\n"));
        GLib.chmod(copy, 0o700);

        let result = installResult(tree);
        Harness.ok(result.status !== 0, "the failed restoration reaches the parent");
        let retained = /backup retained at ([^\n]+)/.exec(result.stderr);
        Harness.ok(retained, "the recovery path is printed: " + result.stderr);
        Harness.equal(read(retained[1] + "/fr.mo"), "old french catalogue",
                      "the only recoverable copy is preserved for manual restoration");
    });
};

cases["an unknown translation action fails without changing catalogues"] = function () {
    installedTree('[ "$1" = -o ] && cp "$3" "$2"', tree => {
        let french = tree.locale + "/fr/LC_MESSAGES/" + Harness.UUID + ".mo";
        write(french, "existing catalogue");

        let result = actionResult(tree, "isntall");
        Harness.ok(result.status !== 0, "the misspelled action is rejected");
        Harness.ok(result.stderr.indexOf("install|uninstall") >= 0,
                   "the diagnostic names the accepted actions");
        Harness.equal(read(french), "existing catalogue",
                      "validation runs before the locale tree is touched");
    });
};

cases["a string with no translation is the string"] = function () {
    /* The ordinary case on the machine this is built on, and on every machine
     * running in English: nothing is installed for the domain, the shell has
     * nothing either, and what comes back is what went in. */
    Harness.equal(Translate._("Power Toys"), "Power Toys", "an applet's own name");
    Harness.equal(Translate._("Governor"), "Governor", "a word the shell also uses");
};

cases["named values are inserted after the complete message is translated"] = function () {
    Harness.equal(Translate.interpolate("Could not switch to %{profile}: %{detail}", {
        profile: "Power saver",
        detail: "$& refused %{profile}",
    }), "Could not switch to Power saver: $& refused %{profile}",
    "replacement text is literal and is not recursively interpreted");
    Harness.equal(Translate.interpolate("%{value} then %{value}", { value: 7 }),
                  "7 then 7", "a translator can move or repeat a named value");
    Harness.equal(Translate.interpolate("Keep %{missing}", {}), "Keep %{missing}",
                  "a catalogue typo remains visible instead of silently deleting text");
};

cases["asking for the translation of anything at all answers with text"] = function () {
    /*
     * Every label in this applet goes through here, including ones built from
     * what a machine said - a firmware profile name, a sensor label. A lookup
     * that threw, or that answered with something a widget cannot draw, would
     * take the menu down with it.
     */
    Fuzz.forAll({ what: "the lookup", runs: 400 },
                random => Fuzz.text(random),
                input => {
                    let out = Fuzz.answers(() => Translate._(input));
                    Fuzz.isString(out, "the translation");
                });
};

cases["the text is what comes back, and not part of it"] = function () {
    /* A catalogue miss must give the string back whole. Half of it, or a
     * key from the catalogue, is a menu that reads as corrupted rather than
     * as untranslated. */
    Fuzz.forAll({ what: "the fallback", runs: 300 },
                random => Fuzz.text(random, 4),
                input => {
                    let out = Translate._(input);
                    if (out !== input)
                        throw new Error("came back as " + JSON.stringify(out));
                });
};
