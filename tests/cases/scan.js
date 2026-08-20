/*
 * The tokeniser both reports are worked out with.
 *
 * tools/scan.js is not the applet, and it is the reason every figure the
 * coverage gate prints is what it is: `blocks` is what says where a function
 * ends, so a mask that got a doc comment or a regular expression wrong would
 * move a function's extent and quietly change its percentage - upward, since
 * a function credited with lines it does not own is usually credited with
 * covered ones. The mutation runner reads the same mask to decide which
 * characters it may edit, so the same mistake there rewrites an operator
 * inside a string and calls the survivor a gap in the suite.
 *
 * Nothing had ever executed a line of it: it is loaded by tools/mutate.js and
 * by tools/coverage-report.js, both of which are processes of their own, so
 * the suite ran none of it and the coverage report - which runs on it - did
 * not list it either. What is held here is the cases the file's own header
 * says it exists for, each one taken from the applet's sources: braces inside
 * strings, doc blocks in front of every function, and patterns with braces
 * and slashes in them.
 */

const Harness = imports.harness;
const Scan = imports.scan;

var cases = {};

/* The mask is the source with everything that is not code blanked; a position
 * in one is the same position in the other, which is the property every
 * caller depends on. */
function masked(source) {
    let mask = Scan.mask(source);
    Harness.equal(mask.length, source.length,
                  "the mask is the same length as the source it describes");
    Harness.equal(mask.split("\n").length, source.split("\n").length,
                  "and has the same number of lines");
    return mask;
}

cases["code survives the mask and comments do not"] = function () {
    let mask = masked("let a = 1; // let b = 2;\nlet c = 3;\n");
    Harness.ok(mask.indexOf("let a = 1;") === 0, "the code is where it was");
    Harness.ok(mask.indexOf("let b") < 0, "the line comment is gone");
    Harness.ok(mask.indexOf("let c = 3;") > 0, "the line after it is not");
};

cases["a doc block is blanked without moving the lines after it"] = function () {
    let source = "/*\n * function hidden() {\n */\nfunction real() {\n}\n";
    let mask = masked(source);
    Harness.ok(mask.indexOf("hidden") < 0, "the commented function is not code");
    Harness.equal(Scan.lineAt(mask, mask.indexOf("function real")), 4,
                  "and the real one is still on its own line");
};

cases["an unterminated block comment ends at the end of the file"] = function () {
    /* Rather than throwing or running off the end: a file this happens to is
     * one the parse check rejects, and this has to answer something first. */
    let mask = masked("let a = 1;\n/* and then nothing closes it\nlet b = 2;\n");
    Harness.ok(mask.indexOf("let b") < 0, "everything after the opener is comment");
};

cases["braces inside strings are not braces"] = function () {
    /* The applet's D-Bus XML and its format strings are full of them; a mask
     * that counted these would pair them against real ones and report every
     * function after the first as ending in the wrong place. */
    let source = "function f() {\n    return \"{ not a block }\";\n}\n";
    let mask = masked(source);
    Harness.equal((mask.match(/\{/g) || []).length, 1, "one opening brace, the real one");
    Harness.equal((mask.match(/\}/g) || []).length, 1, "and one closing brace");
    Harness.deepEqual(Scan.blocks(source), { 1: [3] },
                      "so the function opens on line one and closes on line three");
};

cases["a string spanning lines keeps its newlines"] = function () {
    /* lib/upower.js writes one interface as a string across thirty lines. A
     * mask that dropped those newlines would put every line number after it
     * out by thirty, which is every function in the file. */
    let source = "const XML = '<node>' +\n    '<interface>' +\n    '</node>';\n" +
                 "function after() {\n}\n";
    let mask = masked(source);
    Harness.equal(Scan.lineAt(mask, mask.indexOf("function after")), 4,
                  "the function after the string is on the line it is written on");
    let escaped = "let s = \"a\\\nb\";\nfunction g() {\n}\n";
    Harness.equal(masked(escaped).split("\n").length, escaped.split("\n").length,
                  "a backslash before a newline takes a newline with it");
};

cases["a regular expression is not code and does not open a block"] = function () {
    /* /^\s+([^:]+):\s+(.*?)\s*$/ is in the sensor parsing; the brace in {2}
     * and the slashes in a character class are the two that catch a scanner
     * that counts characters. */
    let source = "function h(text) {\n" +
                 "    return /^[/{]{2}(.*?)$/.test(text);\n" +
                 "}\n";
    let mask = masked(source);
    Harness.equal((mask.match(/\{/g) || []).length, 1,
                  "the only brace left is the function's own");
    Harness.deepEqual(Scan.blocks(source), { 1: [3] }, "so the extent is the whole body");
};

cases["a slash after a value divides rather than opening a pattern"] = function () {
    let source = "function ratio(a, b) {\n    return a / b / 2;\n}\n";
    Harness.deepEqual(Scan.blocks(source), { 1: [3] },
                      "two divisions are not a pattern that swallows the body");
    let after = masked("let x = (a + b) / 2;\nlet y = 3;\n");
    Harness.ok(after.indexOf("let y = 3;") > 0, "and the line after it is still code");
};

cases["a keyword before a slash opens a pattern"] = function () {
    /* `return /x/` is the case the keyword list exists for: return ends in a
     * letter and is not a value. */
    let mask = masked("function m() {\n    return /[}]/;\n}\n");
    Harness.equal((mask.match(/\}/g) || []).length, 1,
                  "the brace inside the pattern is not the function's");
};

cases["a line is the line it is on, counting from one"] = function () {
    let text = "a\nb\nc";
    Harness.equal(Scan.lineAt(text, 0), 1, "the first character is on line one");
    Harness.equal(Scan.lineAt(text, 2), 2, "the character after the first newline is on two");
    Harness.equal(Scan.lineAt(text, 4), 3, "and so on");
    Harness.equal(Scan.lineAt(text, 4000), 3,
                  "a position past the end is the last line rather than an error");
};

cases["every block is recorded by the line it opened on"] = function () {
    let source = "function outer() {\n" +
                 "    if (true) {\n" +
                 "        return 1;\n" +
                 "    }\n" +
                 "}\n";
    Harness.deepEqual(Scan.blocks(source), { 1: [5], 2: [4] },
                      "the inner block closes before the outer one");
};

cases["one line can open more than one block"] = function () {
    /* `.sort((a, b) => {` opens the call and the body as far as this is
     * concerned, and the coverage report reads the first of them. */
    let source = "let s = list.sort((a, b) => { return a - b; }).map(x => { return x; });\n";
    Harness.deepEqual(Scan.blocks(source), { 1: [1, 1] },
                      "both are recorded against the line, in the order they opened");
};

cases["an unbalanced brace closes nothing rather than throwing"] = function () {
    Harness.deepEqual(Scan.blocks("}\n"), {},
                      "a closing brace with nothing open is ignored");
    Harness.deepEqual(Scan.blocks("function f() {\n"), {},
                      "and a block that never closes is not reported as closing");
};

cases["the applet's own sources balance under the mask"] = function () {
    /* The end of it: whatever the rules above are, the answer has to be right
     * about the files the reports are actually made of. A source whose braces
     * do not pair is one the mask got wrong, since the parse check has
     * already said the engine accepts every one of them. */
    let Sources = imports.sources;
    let xlet = Harness.xletDir();
    let checked = 0;
    for (let relative of Sources.jsFiles(xlet, "")) {
        let source = Harness.readFile(xlet + "/" + relative);
        let mask = Scan.mask(source);
        Harness.equal(mask.length, source.length, relative + " masks to its own length");
        Harness.equal((mask.match(/\{/g) || []).length,
                      (mask.match(/\}/g) || []).length,
                      relative + " has as many opening braces in code as closing ones");
        checked++;
    }
    Harness.ok(checked > 0, "there were sources to check");
};

/*
 * The other half of the same walk.
 *
 * A gate that asks whether the sources name something - an icon, a style
 * class, a settings key - is asking about literals, and the raw text answers
 * yes to a name that is only written in a comment explaining it. The mask
 * cannot answer it either: a mask blanks a string and a comment alike.
 */
cases["the literals are the strings and not the prose"] = function () {
    let source = [
        'let a = "one";',
        '/* "a comment naming two" */',
        'let b = `two`;',
        "// \"and a line comment\"",
        'let c = \'three\';',
    ].join("\n");
    Harness.deepEqual(Scan.literals(source), ["one", "two", "three"],
                      "every quote is a literal and no comment is");
};

cases["a literal is the text between the quotes"] = function () {
    Harness.deepEqual(Scan.literals('let a = "x" + "y";'), ["x", "y"],
                      "two literals rather than the expression they are in");
    Harness.deepEqual(Scan.literals('let a = "an escaped \\" quote";'),
                      ['an escaped \\" quote'],
                      "an escaped quote does not end the literal");
    Harness.deepEqual(Scan.literals('let a = "";'), [""],
                      "an empty literal is a literal");
    Harness.deepEqual(Scan.literals("let a = /\"not a string\"/.test(b);"), [],
                      "and a pattern is not one");
    Harness.deepEqual(Scan.literals("let a = 1;"), [],
                      "a file with no strings in it has none");
};

cases["a literal written across lines comes back whole"] = function () {
    /* The interface XML in lib/upower.js is written this way. */
    let source = "const XML = \"<node>\" +\n    \"<interface/>\" +\n    \"</node>\";\n";
    Harness.deepEqual(Scan.literals(source), ["<node>", "<interface/>", "</node>"],
                      "each piece is its own literal, in the order written");
};
