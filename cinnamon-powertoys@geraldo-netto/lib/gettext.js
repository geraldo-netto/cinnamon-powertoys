/*
 * cinnamon-powertoys - translation.
 *
 * bindtextdomain has to be called once, with the xlet's own domain and the
 * directory the install puts compiled catalogues in, and every file that shows
 * text needs the same _(). Doing that in each file meant writing the applet's
 * identity into libraries that have no business knowing it.
 *
 * Cinnamon hands every xlet file its own metadata, so nothing here is
 * hard-coded: the domain is whatever xlet this module was loaded for.
 */

const Gettext = imports.gettext;
const GLib = imports.gi.GLib;

var UUID = __meta.uuid;

/* An installed applet lives below <data root>/cinnamon/applets/<uuid>, while
 * install-translations.sh puts its catalogues below <data root>/locale. Keep
 * the user data directory as the development fallback, where the module path
 * is a checkout rather than an installed Cinnamon path. */
function localeDirectory(path) {
    let suffix = "/cinnamon/applets/" + UUID;
    let clean = String(path || "").replace(/\/+$/, "");
    if (clean.slice(-suffix.length) === suffix)
        return clean.slice(0, -suffix.length) + "/locale";
    return GLib.get_user_data_dir() + "/locale";
}

var LOCALE_DIR = localeDirectory(__meta.path);

function bindDomain() {
    Gettext.bindtextdomain(UUID, LOCALE_DIR);
}

bindDomain();

/* Cinnamon binds an xlet's domain to the user locale directory after main()
 * returns. Re-apply the path on the next loop turn so system and custom-prefix
 * installations are not overwritten by that default. */
if (typeof GLib.idle_add === "function") {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, function () {
        bindDomain();
        return GLib.SOURCE_REMOVE;
    });
}

/*
 * Falls back to the shell's own catalogue, which already carries most of the
 * words a power menu uses, so an untranslated locale still reads correctly
 * for the common terms.
 */
function _(text) {
    let translated = Gettext.dgettext(UUID, text);
    if (translated !== text)
        return translated;
    return Gettext.gettext(text);
}

/*
 * The plural equivalent of _(). Keep the xlet domain first and the shell's
 * catalogue as the same useful fallback, while leaving plural selection to
 * gettext rather than assuming that every language has English's two forms.
 */
function ngettext(singular, plural, count) {
    let translated = Gettext.dngettext(UUID, singular, plural, count);
    let untranslated = Number(count) === 1 ? singular : plural;
    if (translated !== untranslated)
        return translated;
    return Gettext.ngettext(singular, plural, count);
}

/*
 * Substitute named values only after gettext has translated the complete
 * sentence. A translator can move a placeholder with its punctuation instead
 * of being constrained by the English order of separately translated pieces.
 */
function interpolate(text, values) {
    let fields = values || {};
    return String(text).replace(/%\{([A-Za-z][A-Za-z0-9_]*)\}/g,
        function (placeholder, name) {
            return Object.prototype.hasOwnProperty.call(fields, name)
                ? String(fields[name]) : placeholder;
        });
}
