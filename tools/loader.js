/*
 * Cinnamon's xlet loader, as closely as anything outside Cinnamon can copy it.
 *
 * misc/fileUtils.js is what the shell actually evaluates an applet file with,
 * and two things in this repository have to agree with it exactly: the parse
 * check, which must reject what the loader would reject, and the test harness,
 * which must hand a library the same environment the shell hands it. They each
 * carried their own copy of the wrapper, and a copy is a thing that drifts -
 * one of them growing a seventh parameter or losing the strict prefix would
 * have gone unnoticed until a construct passed the check and failed in the
 * shell, which is the one failure this repository has no way to see.
 *
 * So the emulation lives here once and both use it. Everything in this file is
 * a statement about what Cinnamon does, not about what would be convenient.
 */

const GLib = imports.gi.GLib;

/* The names the loader binds, in the order it binds them. */
var PARAMETERS = ["require", "exports", "module", "__meta", "__dirname", "__filename"];

/* Prepended to every xlet file, which is why an applet cannot opt out of
 * strict mode and why the parse check has to apply it too. */
var PREAMBLE = "'use strict';";

/*
 * The names the loader refuses to re-export, because they are its own import
 * namespaces rather than anything the module defined.
 *
 * Copied out of fileUtils.js verbatim, capitals and all, and that is the whole
 * point of it: the candidate is lowercased before it is looked up in here, so
 * `jsUnit`, `byteArray` and `cairoNative` can never match anything and
 * Cinnamon does re-export a top level declaration of any of those three. An
 * emulation that tidied the list into lower case would drop them, which is a
 * different loader from the one the shell runs.
 *
 * So this list is not corrected, and there is a case in tests/cases/loading.js
 * that reads the real file and fails if the two ever come apart.
 */
var IMPORT_NAMES = ["mainloop", "jsUnit", "format", "signals", "lang", "tweener",
                    "overrides", "gettext", "coverage", "package", "cairo",
                    "byteArray", "cairoNative"];

function decode(bytes) {
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

function read(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("cannot read " + path);
    return decode(bytes);
}

/*
 * The loaded GI namespaces, which the loader also excludes: a module that says
 * `const Gio = imports.gi.Gio` has not defined Gio. Asking the repository is
 * how the loader knows, and the list is only a fallback for an interpreter
 * that will not answer.
 */
function giNames() {
    try {
        let repository = imports.gi.GIRepository.Repository;
        let instance = repository.dup_default ? repository.dup_default() : repository.get_default();
        return instance.get_loaded_namespaces();
    } catch (e) {
        return ["Gio", "GLib", "St", "Clutter", "UPowerGlib", "GObject", "Gtk", "Gdk"];
    }
}

/*
 * What the loader appends to a module that never assigns module.exports: one
 * line per top level declaration, so a library gets its exports without
 * writing any. The regexes are fileUtils.js's own.
 */
function exportAssignments(js, names) {
    const exportsRegex = /^module\.exports(\.[a-zA-Z0-9_$]+)?\s*=/m;
    const varRegex = /^(?:'use strict';){0,}(const|var|let|function|class)\s+([a-zA-Z0-9_$]+)/gm;

    if (exportsRegex.test(js))
        return "";

    let gi = names || giNames();
    let out = "";
    let match;
    while ((match = varRegex.exec(js)) !== null) {
        if (match.index === varRegex.lastIndex)
            varRegex.lastIndex++;
        if (match[2] && IMPORT_NAMES.indexOf(match[2].toLowerCase()) === -1 &&
            gi.indexOf(match[2]) === -1)
            out += "exports." + match[2] + " = typeof " + match[2] +
                   " !== 'undefined' ? " + match[2] + " : null;";
    }
    return out;
}

/* The whole body the loader evaluates for one module. */
function moduleBody(source, names) {
    let js = PREAMBLE + source + ";";
    return js + exportAssignments(js, names) + "return module.exports;";
}

/*
 * Parses a body with the same engine and the same parameter names Cinnamon
 * uses, without evaluating a statement of it. Throws what the engine throws,
 * which carries the line number.
 */
function compile(body) {
    return new Function(...PARAMETERS.concat([body]));
}
