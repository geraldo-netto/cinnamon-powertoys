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
/* Where the install path compiles catalogues to. get_user_data_dir()
 * respects XDG_DATA_HOME, which the install script reads too, so the two
 * agree even where that is set. */
var LOCALE_DIR = GLib.get_user_data_dir() + "/locale";

Gettext.bindtextdomain(UUID, LOCALE_DIR);

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
