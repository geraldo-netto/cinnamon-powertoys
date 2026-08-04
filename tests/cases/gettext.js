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
const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Translate = Harness.requireXlet("./lib/gettext.js");

var cases = {};

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

cases["a string with no translation is the string"] = function () {
    /* The ordinary case on the machine this is built on, and on every machine
     * running in English: nothing is installed for the domain, the shell has
     * nothing either, and what comes back is what went in. */
    Harness.equal(Translate._("Power Toys"), "Power Toys", "an applet's own name");
    Harness.equal(Translate._("Governor"), "Governor", "a word the shell also uses");
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
