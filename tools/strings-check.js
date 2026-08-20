#!/usr/bin/env cjs
/*
 * Every string the applet asks to have translated is a string the template
 * offers a translator.
 *
 * The template is held to the sources by one CI step, which downloads
 * cinnamon-xlet-makepot from a pinned Cinnamon commit and diffs what it
 * regenerates. That is the thorough answer and it stays; what it is not is an
 * answer anybody gets before pushing. `make check` runs the whole of the rest
 * of this repository's gates and had nothing at all to say about the strings,
 * so adding a translatable sentence and not running `make pot` was a green
 * local tree and a red push.
 *
 * This is the half of that question a machine with no extractor can answer:
 * every literal handed to _(), N_() and ngettext(), found with the engine's
 * own parser rather than by pattern, looked up in the template. It is
 * deliberately one-directional. A msgid the sources no longer use is stale
 * rather than broken, and the template also legitimately carries strings that
 * came from the polkit action, which is not JavaScript and is not read here.
 *
 * Usage: strings-check.js POT_FILE SOURCE ...
 */

const GLib = imports.gi.GLib;
const System = imports.system;

/* The names a translated string is written under. `_` and `N_` translate one
 * string; ngettext takes the singular and the plural, and the template has to
 * carry both. */
const SINGULAR = ["_", "N_"];
const PLURAL = ["ngettext"];

function read(path) {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error("cannot read " + path);
    try {
        return new TextDecoder().decode(bytes);
    } catch (error) {
        return imports.byteArray.toString(bytes);
    }
}

/*
 * The value of an argument, if it is one the extractor can see too.
 *
 * A literal, or literals joined by +, which is how a sentence too long for a
 * line is written here. Anything else - a variable, a template with a
 * substitution - is a string the extractor cannot read either, so it is not
 * this file's to complain about.
 */
function literal(node) {
    if (!node)
        return null;
    if (node.type === "Literal" && typeof node.value === "string")
        return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0 &&
            node.quasis.length === 1)
        return node.quasis[0].value.cooked;
    if (node.type === "BinaryExpression" && node.operator === "+") {
        let left = literal(node.left);
        let right = literal(node.right);
        return left === null || right === null ? null : left + right;
    }
    return null;
}

/* The name a call is made under, whether it is written `_(...)` or
 * `Translate._(...)`. */
function calleeName(callee) {
    if (!callee)
        return null;
    if (callee.type === "Identifier")
        return callee.name;
    if (callee.type === "MemberExpression" && !callee.computed &&
            callee.property.type === "Identifier")
        return callee.property.name;
    return null;
}

/* Every node of a parse tree, without knowing what any of them are. */
function walk(node, visit) {
    if (!node || typeof node !== "object")
        return;
    if (Array.isArray(node)) {
        for (let child of node)
            walk(child, visit);
        return;
    }
    if (typeof node.type === "string")
        visit(node);
    for (let key in node) {
        if (key !== "loc" && key !== "type")
            walk(node[key], visit);
    }
}

/* What one file asks to have translated, as { text, line }. */
function requestedStrings(path) {
    let tree = Reflect.parse(read(path), { source: path, loc: true });
    let found = [];

    walk(tree, function (node) {
        if (node.type !== "CallExpression")
            return;
        let name = calleeName(node.callee);
        let wanted = SINGULAR.indexOf(name) >= 0 ? 1
            : PLURAL.indexOf(name) >= 0 ? 2 : 0;
        let line = node.loc ? node.loc.start.line : 0;
        for (let i = 0; i < wanted; i++) {
            let text = literal(node.arguments[i]);
            if (text !== null && text !== "")
                found.push({ text: text, line: line });
        }
    });
    return found;
}

/*
 * A msgid as gettext writes it: one or more quoted parts on their own lines,
 * with the C escapes a .po file uses. Unescaped here so the comparison is
 * between two JavaScript strings rather than between two spellings of one.
 */
function unescape(text) {
    return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, function (all, escape) {
        if (escape[0] === "u" || escape[0] === "x")
            return String.fromCharCode(parseInt(escape.slice(1), 16));
        switch (escape) {
        case "n": return "\n";
        case "t": return "\t";
        case "r": return "\r";
        default: return escape;
        }
    });
}

function templateStrings(path) {
    let lines = read(path).split("\n");
    let known = {};
    let collecting = false;
    let current = "";

    let finish = function () {
        if (collecting && current !== "")
            known[current] = true;
        collecting = false;
        current = "";
    };

    for (let line of lines) {
        let start = /^(?:msgid|msgid_plural)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
        if (start) {
            finish();
            collecting = true;
            current = unescape(start[1]);
            continue;
        }
        let more = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
        if (collecting && more) {
            current += unescape(more[1]);
            continue;
        }
        finish();
    }
    finish();
    return known;
}

if (ARGV.length < 2) {
    printerr("usage: strings-check.js POT_FILE SOURCE ...");
    System.exit(2);
}

let template = templateStrings(ARGV[0]);
let missing = [];
let checked = 0;

for (let source of ARGV.slice(1)) {
    for (let request of requestedStrings(source)) {
        checked++;
        if (!template[request.text]) {
            missing.push(source + ":" + request.line + ": " +
                         JSON.stringify(request.text));
        }
    }
}

if (missing.length > 0) {
    printerr("strings FAIL " + missing.length +
             " translatable strings are not in " + ARGV[0] + ":");
    for (let line of missing)
        printerr("  " + line);
    printerr("run 'make pot' and commit the result");
    System.exit(1);
}

print("strings ok   " + checked + " translatable strings, all in the template");
