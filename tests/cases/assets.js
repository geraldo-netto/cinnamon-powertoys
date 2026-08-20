/*
 * The names the sources ask for, and the assets that answer them - in both
 * directions.
 *
 * An applet asks for an icon and a style class by writing its name in a
 * string. Nothing fails when the name is wrong: St draws no icon and the
 * theme applies no rule, so a typo is a panel with a blank space in it or a
 * menu with one row's padding missing, on somebody else's desktop, months
 * later. And nothing fails when the name is right and the file is not used
 * either - a rule for a class nobody applies, or an SVG installed on every
 * desktop that draws nothing - which is how dead assets survive a rename.
 *
 * So both directions are held here. Every name the sources ask for has
 * something that answers it, and every asset that ships is asked for.
 *
 * Read as literals rather than as text: every one of these names is also
 * written in the comments that explain it, and a gate that greps the file
 * cannot tell the two apart - which would make a rename that changed only the
 * prose pass, and a comment that mentioned a deleted class enough to keep it
 * alive. tools/scan.js is what knows which is which.
 */

const Gio = imports.gi.Gio;
const Harness = imports.harness;
const Scan = imports.scan;
const Sources = imports.sources;

const PREFIX = "powertoys-";

/* A whole name, as opposed to a piece of one: `"powertoys-" + kind` is two
 * literals and neither of them is a name. */
const WHOLE = /^powertoys-[a-z0-9]+(-[a-z0-9]+)*$/;

function payload() {
    return Harness.xletDir();
}

/* Every string literal written in the applet's own JavaScript, with the file
 * it came from, so a failure names somewhere to go. */
function literals() {
    let found = [];
    for (let relative of Sources.jsFiles(payload(), "")) {
        for (let text of Scan.literals(Harness.readFile(payload() + "/" + relative)))
            found.push({ file: relative, text: text });
    }
    return found;
}

function texts(entries) {
    return entries.map(entry => entry.text);
}

/* The icons that ship, by the name St would be asked for: the file name
 * without its extension. */
function shippedIcons() {
    let names = [];
    let folder = Gio.File.new_for_path(payload() + "/icons");
    let entries = folder.enumerate_children("standard::name",
                                            Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null) {
        let name = info.get_name();
        if (name.slice(-4) === ".svg")
            names.push(name.slice(0, -4));
    }
    entries.close(null);
    return names.sort();
}

/* Every class the stylesheet has a rule for, from selectors rather than from
 * the comments that explain them. */
function styleClasses() {
    let css = Harness.readFile(payload() + "/stylesheet.css")
        .replace(/\/\*[\s\S]*?\*\//g, " ");
    let found = {};
    let pattern = /\.(powertoys-[a-z0-9-]+)/g;
    let match;
    while ((match = pattern.exec(css)) !== null)
        found[match[1]] = true;
    return Object.keys(found).sort();
}

/*
 * Whether the sources can assemble a name they never write in one piece.
 *
 * `"powertoys-" + kind + "-title"` is how one heading serves a group and a
 * subgroup, so `.powertoys-subgroup-title` is applied by a file that does not
 * contain it. What is required is the two ends: a literal the name starts
 * with that is itself a fragment, and a literal it ends with, with something
 * left between them. Looser than an exact match on purpose - it has to be, to
 * describe a name built at runtime - so it is the fallback and not the rule.
 */
function assembled(name, written) {
    for (let head of written) {
        if (head === "" || head.slice(-1) !== "-" || name.indexOf(head) !== 0)
            continue;
        for (let tail of written) {
            if (tail === "" || tail[0] !== "-")
                continue;
            if (name.slice(-tail.length) === tail &&
                name.length > head.length + tail.length)
                return true;
        }
    }
    return false;
}

/* The other places a name may be answered from: the helper's error protocol
 * is `powertoys-helper-error <code>`, written in the helper and read in
 * lib/privileged.js, and that is a name in the sources that is neither an
 * icon nor a class. Read out of the shipped file rather than exempted here. */
function otherPayloadText() {
    return Harness.readFile(payload() + "/powertoys-helper");
}

var cases = {};

cases["every icon the applet ships is one the applet asks for"] = function () {
    let written = texts(literals());
    let icons = shippedIcons();
    Harness.ok(icons.length > 0, "there are icons to check");
    let dead = icons.filter(name => written.indexOf(name) < 0 &&
        written.indexOf(name.replace(/-symbolic$/, "")) < 0);
    Harness.deepEqual(dead, [],
                      "an icon no source names is installed on every desktop and drawn nowhere");
};

cases["no two icons are the same drawing under two names"] = function () {
    /* A rename that copies rather than moves leaves both, and both pass every
     * other check here. */
    let seen = {};
    for (let name of shippedIcons()) {
        let text = Harness.readFile(payload() + "/icons/" + name + ".svg");
        Harness.ok(seen[text] === undefined,
                   name + " and " + seen[text] + " are the same drawing under two names");
        seen[text] = name;
    }
};

cases["every style class the stylesheet has a rule for is applied"] = function () {
    let written = texts(literals());
    let classes = styleClasses();
    Harness.ok(classes.length > 10, "there are style rules to check");
    let dead = classes.filter(name => written.indexOf(name) < 0 &&
                                      !assembled(name, written));
    Harness.deepEqual(dead, [],
                      "a rule for a class nothing applies is style nobody sees");
};

cases["every name the applet asks for is one something answers"] = function () {
    /* The other direction, and the one a typo shows up in: a name that is
     * neither an icon that ships, nor a class the stylesheet has a rule for,
     * nor a word the helper protocol uses, is a name whose only effect is
     * that nothing happens. */
    let classes = styleClasses();
    let icons = shippedIcons();
    let helper = otherPayloadText();
    let unanswered = [];
    for (let entry of literals()) {
        if (!WHOLE.test(entry.text))
            continue;
        if (classes.indexOf(entry.text) >= 0)
            continue;
        if (icons.indexOf(entry.text) >= 0 || icons.indexOf(entry.text + "-symbolic") >= 0)
            continue;
        if (helper.indexOf(entry.text) >= 0)
            continue;
        unanswered.push(entry.file + " asks for " + entry.text);
    }
    Harness.deepEqual(unanswered, [],
                      "every " + PREFIX + " name is an icon, a style rule or the helper protocol");
};
