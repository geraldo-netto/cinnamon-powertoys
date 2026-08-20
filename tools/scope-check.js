#!/usr/bin/env cjs
/*
 * Resolves every identifier in the files given on the command line, and
 * reports the ones that resolve to nothing.
 *
 * The parse check says a file is a file the engine will accept. It says
 * nothing about whether a name written in it exists, and a name that does not
 * is not a syntax error - it is a ReferenceError at the moment that line runs,
 * which for applet.js is on a user's panel and nowhere else. Nothing in this
 * repository can evaluate applet.js: it imports the shell. So a method reading
 * a parameter belonging to a different method parsed, linted, packaged and
 * shipped through 1118 green cases, and took the applet off the panel of every
 * machine that installed it.
 *
 * Reflect.parse is the same engine's parser, which is the whole reason this
 * needs no toolchain: the tree already depends on cjs. What is done with the
 * tree is deliberately the smallest thing that would have caught that - every
 * scope's declarations collected, every identifier looked up along the scope
 * chain, and anything unfound reported with its line. It is not a linter and
 * makes no style judgements.
 */

const GLib = imports.gi.GLib;
const System = imports.system;

function scriptDir() {
    let invoked = System.programInvocationName;
    if (invoked[0] !== "/")
        invoked = GLib.get_current_dir() + "/" + invoked;
    return GLib.path_get_dirname(invoked);
}

imports.searchPath.unshift(scriptDir());
const Loader = imports.loader;

/*
 * The names that are there without anybody declaring them.
 *
 * Three sets, all of them true of every file this is run over: the language's
 * own, what cjs binds for a script it runs, and what Cinnamon's loader binds
 * for an xlet module - which is Loader.PARAMETERS, read from the emulation
 * rather than written out again, so the two cannot come to disagree.
 *
 * `imports` covers the GI namespaces as well: `imports.gi.Gio` is a property
 * lookup and the name bound from it is an ordinary declaration.
 */
const LANGUAGE = [
    "globalThis", "undefined", "NaN", "Infinity", "arguments", "eval",
    "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol",
    "Math", "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
    "Promise", "Proxy", "Reflect", "Error", "TypeError", "RangeError",
    "SyntaxError", "ReferenceError", "EvalError", "URIError",
    "parseInt", "parseFloat", "isNaN", "isFinite", "escape", "unescape",
    "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
    "ArrayBuffer", "DataView", "Uint8Array", "Int8Array", "Uint16Array",
    "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array",
    "TextDecoder", "TextEncoder", "Intl", "console", "globalThis",
];

/* What the interpreter running a script binds, and what the shell leaves on
 * the global object for anything running inside it. */
const RUNTIME = ["imports", "ARGV", "print", "printerr", "log", "logError",
                 "global", "window", "setTimeout", "clearTimeout"];

const GLOBALS = LANGUAGE.concat(RUNTIME).concat(Loader.PARAMETERS);

function newScope(parent) {
    return { parent: parent, names: Object.create(null) };
}

function declare(scope, name) {
    if (name)
        scope.names[name] = true;
}

function resolves(scope, name) {
    for (let current = scope; current; current = current.parent) {
        if (current.names[name])
            return true;
    }
    return GLOBALS.indexOf(name) !== -1;
}

/*
 * Every name a binding form binds.
 *
 * One function for all of them because a parameter, a `let` and a catch
 * clause bind the same shapes: a name, a destructured object or array, a rest
 * element, or a default written as an assignment.
 */
function boundNames(node, out) {
    if (!node)
        return out;
    switch (node.type) {
    case "Identifier":
        out.push(node.name);
        break;
    case "ObjectPattern":
        for (let property of node.properties)
            boundNames(property.value || property.argument || property, out);
        break;
    case "ArrayPattern":
        for (let element of node.elements)
            boundNames(element, out);
        break;
    case "Property":
        boundNames(node.value, out);
        break;
    case "AssignmentExpression":
    case "AssignmentPattern":
        boundNames(node.left, out);
        break;
    case "RestElement":
    case "SpreadExpression":
    case "SpreadElement":
        boundNames(node.argument, out);
        break;
    default:
        break;
    }
    return out;
}

function declareAll(scope, node) {
    for (let name of boundNames(node, []))
        declare(scope, name);
}

/*
 * `var` and function declarations reach the whole of the function they are
 * written in, wherever inside it they are written, so they are collected
 * before anything in that function is resolved. Nested functions are not
 * descended into: their own bodies belong to their own scope.
 */
function hoist(node, scope) {
    if (!node || typeof node !== "object")
        return;
    if (Array.isArray(node)) {
        for (let child of node)
            hoist(child, scope);
        return;
    }
    if (!node.type)
        return;
    switch (node.type) {
    case "FunctionDeclaration":
    case "ClassStatement":
    case "ClassDeclaration":
        declare(scope, node.id && node.id.name);
        return;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
        return;
    case "VariableDeclaration":
        for (let declarator of node.declarations)
            declareAll(scope, declarator.id);
        return;
    default:
        break;
    }
    for (let key in node) {
        if (key !== "loc" && key !== "type")
            hoist(node[key], scope);
    }
}

const Report = class Report {
    constructor(path) {
        this._path = path;
        this._seen = Object.create(null);
        this.count = 0;
    }

    /* One line per name per line of source: a name used four times on one line
     * is one mistake. */
    add(name, loc) {
        let line = loc ? loc.start.line : 0;
        let key = name + ":" + line;
        if (this._seen[key])
            return;
        this._seen[key] = true;
        this.count++;
        printerr("undefined   " + this._path + ":" + line + ": " + name);
    }
};

const Walk = class Walk {
    constructor(report) {
        this._report = report;
    }

    /* A function's own scope: its name, its parameters, and `arguments`. */
    _function(node, scope) {
        let inner = newScope(scope);
        declare(inner, node.id && node.id.name);
        for (let parameter of node.params || [])
            declareAll(inner, parameter);
        if (node.rest)
            declareAll(inner, node.rest);
        declare(inner, "arguments");
        hoist(node.body, inner);
        this.walk(node.body, inner);
    }

    walk(node, scope) {
        if (!node || typeof node !== "object")
            return;
        if (Array.isArray(node)) {
            for (let child of node)
                this.walk(child, scope);
            return;
        }
        if (!node.type)
            return;

        switch (node.type) {
        case "Identifier":
            if (!resolves(scope, node.name))
                this._report.add(node.name, node.loc);
            return;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
            this._function(node, scope);
            return;
        case "ClassStatement":
        case "ClassDeclaration":
        case "ClassExpression": {
            /* The class name is in scope inside its own body, which is how a
             * static factory refers to the class it is on. */
            let inner = newScope(scope);
            declare(inner, node.id && node.id.name);
            this.walk(node.superClass, inner);
            this.walk(node.body, inner);
            return;
        }
        case "ClassMethod":
        case "MethodDefinition":
        case "ClassField":
        case "PropertyDefinition":
            /* `foo` in `{ foo() {} }` names a member, not a variable - unless
             * it is computed, where it is an expression like any other. */
            if (node.computed)
                this.walk(node.key || node.name, scope);
            this.walk(node.value || node.init || node.body, scope);
            return;
        case "MemberExpression":
        case "OptionalMemberExpression":
            this.walk(node.object, scope);
            if (node.computed)
                this.walk(node.property, scope);
            return;
        case "Property":
        case "ObjectProperty":
            if (node.computed)
                this.walk(node.key, scope);
            this.walk(node.value, scope);
            return;
        case "VariableDeclaration":
            for (let declarator of node.declarations) {
                declareAll(scope, declarator.id);
                this.walk(declarator.init, scope);
            }
            return;
        case "CatchClause": {
            let inner = newScope(scope);
            declareAll(inner, node.param);
            hoist(node.body, inner);
            this.walk(node.body, inner);
            return;
        }
        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement": {
            /* The head declares into the loop's own scope, not the enclosing
             * one: `for (let x of ...)` must not leak x. */
            let inner = newScope(scope);
            if (node.type === "ForStatement") {
                this.walk(node.init, inner);
                this.walk(node.test, inner);
                this.walk(node.update, inner);
            } else {
                this.walk(node.left, inner);
                this.walk(node.right, inner);
            }
            this.walk(node.body, inner);
            return;
        }
        case "BlockStatement": {
            let inner = newScope(scope);
            for (let statement of node.body) {
                if (statement.type === "FunctionDeclaration" ||
                    statement.type === "ClassStatement" ||
                    statement.type === "ClassDeclaration")
                    declare(inner, statement.id && statement.id.name);
            }
            this.walk(node.body, inner);
            return;
        }
        case "LabeledStatement":
            /* The label is not a variable, and neither is the name a break or
             * a continue carries. */
            this.walk(node.body, scope);
            return;
        case "BreakStatement":
        case "ContinueStatement":
            return;
        default:
            break;
        }

        for (let key in node) {
            if (key !== "loc" && key !== "type")
                this.walk(node[key], scope);
        }
    }
};

function checkFile(path) {
    let source;
    try {
        source = Loader.read(path);
    } catch (error) {
        printerr("unreadable  " + path + ": " + error.message);
        return 1;
    }

    let tree;
    try {
        tree = Reflect.parse(source, { loc: true, source: path });
    } catch (error) {
        /* The parse check reports this properly; here it is only a file that
         * cannot be resolved. */
        printerr("unparsable  " + path + ": " + error);
        return 1;
    }

    let report = new Report(path);
    let top = newScope(null);
    hoist(tree, top);
    new Walk(report).walk(tree.body, top);
    return report.count;
}

if (ARGV.length === 0) {
    printerr("usage: scope-check.js <file>...");
    System.exit(2);
}

let failures = 0;
for (let path of ARGV)
    failures += checkFile(path);

if (failures === 0)
    print("scope ok     every name resolves");
System.exit(failures > 0 ? 1 : 0);
