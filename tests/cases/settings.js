/*
 * The settings schema and the applet's table of them, against each other.
 *
 * applet.js cannot be loaded outside Cinnamon - it imports the shell's own
 * modules at the top - so this reads it as text. That is enough for the one
 * thing worth checking here, which is that the two lists have not drifted:
 * a key in the schema and not in the table is a setting the user can change
 * and the applet never reads, and a key in the table and not in the schema
 * binds to nothing and leaves its property undefined.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

function readFile(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("cannot read " + path);
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

function schemaKeys() {
    let schema = JSON.parse(readFile(Harness.xletDir() + "/settings-schema.json"));
    return Object.keys(schema).filter(key => schema[key].type !== "section").sort();
}

function tableEntries() {
    let source = readFile(Harness.xletDir() + "/applet.js");
    let table = source.slice(source.indexOf("const SETTINGS = ["),
                             source.indexOf("];", source.indexOf("const SETTINGS = [")));
    let entries = [];
    let pattern = /\{ key: "([^"]+)", property: "([^"]+)"/g;
    let match;
    while ((match = pattern.exec(table)) !== null)
        entries.push({ key: match[1], property: match[2] });
    return entries;
}

var cases = {};

cases["every setting in the schema is bound"] = function () {
    let bound = tableEntries().map(entry => entry.key);
    let unread = schemaKeys().filter(key => bound.indexOf(key) < 0);
    Harness.deepEqual(unread, [],
                      "the user can change these and the applet never reads them");
};

cases["every setting the applet binds is in the schema"] = function () {
    let keys = schemaKeys();
    let unknown = tableEntries().map(e => e.key).filter(key => keys.indexOf(key) < 0);
    Harness.deepEqual(unknown, [],
                      "these bind to nothing and leave their property undefined");
};

cases["no key is declared twice"] = function () {
    let seen = {};
    let twice = [];
    for (let entry of tableEntries()) {
        if (seen[entry.key])
            twice.push(entry.key);
        seen[entry.key] = true;
    }
    Harness.deepEqual(twice, [], "a second binding would overwrite the first");
};

cases["no property is used twice"] = function () {
    let seen = {};
    let clashes = [];
    for (let entry of tableEntries()) {
        if (seen[entry.property])
            clashes.push(entry.property + " for " + seen[entry.property] + " and " + entry.key);
        seen[entry.property] = entry.key;
    }
    Harness.deepEqual(clashes, [], "two settings writing to one property");
};

cases["a property name still matches its key"] = function () {
    /* Written out rather than transformed, but they should still agree, or
     * the next reader has to look the pair up every time. */
    let wrong = tableEntries()
        .filter(function (entry) {
            let expected = entry.key.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
            return entry.property !== expected;
        })
        .map(entry => entry.key + " is bound to " + entry.property);
    Harness.deepEqual(wrong, [], "surprising names");
};

cases["a setting that needs more than a repaint says so"] = function () {
    let source = readFile(Harness.xletDir() + "/applet.js");
    let table = source.slice(source.indexOf("const SETTINGS = ["),
                             source.indexOf("];", source.indexOf("const SETTINGS = [")));
    for (let key of ["refresh-interval", "temp-unit", "monitor-brightness",
                     "cycle-profile-hotkey", "toggle-menu-hotkey", "panel-icon-source"]) {
        let line = table.split("\n").find(text => text.indexOf('"' + key + '"') >= 0);
        Harness.ok(line && line.indexOf("onChange") >= 0,
                   key + " would only redraw, which is not enough for it");
    }
};
