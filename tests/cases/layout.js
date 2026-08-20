/*
 * The layout gate, given the mistakes it exists to catch.
 *
 * tools/check-layout.sh is what holds the working tree to the shape a
 * Cinnamon Spices archive has to have, and it runs twice on every release
 * path - from `make check` and again from inside the packaging tool, which
 * refuses to build over a tree it rejects. Nothing had ever seen it fail. A
 * gate whose list stopped being read, or whose exit status stopped being
 * looked at, goes on printing "layout ok" over anything, and the failure it
 * would have caught arrives as a rejected submission or as an applet that
 * does not load on somebody's desktop.
 *
 * So each rule is given a tree with exactly its own mistake in it. The tree is
 * a copy - the repository's own payload, with one thing changed - because a
 * rule stated over a tree that is nothing like the real one proves the script
 * refuses something rather than that it refuses this.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const UUID = "cinnamon-powertoys@geraldo-netto";

function root() {
    return Harness.testsDir() + "/..";
}

function run(argv, directory) {
    return Harness.settle(done => Privileged._spawn(
        ["sh", "-c", 'cd "$1" && shift && exec "$@"', "layout", directory].concat(argv),
        (status, stderr, stdout) => done({
            status: status, output: (stdout || "") + (stderr || ""),
        })), "the layout check");
}

/*
 * A copy of what the gate reads - the payload and the three wrapper assets -
 * with `change` applied to it. Only what it reads is copied: a whole-tree copy
 * would carry the history and the coverage output through every case here.
 */
function overTree(change) {
    let directory = GLib.dir_make_tmp("powertoys-layout-XXXXXX");
    try {
        let copied = Harness.settle(done => Privileged._spawn(
            ["sh", "-c", 'cd "$1" && cp -R files info.json README.md screenshot.png "$2"',
             "tree-copy", root(), directory],
            (status, stderr) => done({ status: status, stderr: stderr })), "the tree copy");
        Harness.equal(copied.status, 0, "the tree was copied: " + copied.stderr);
        if (change)
            change(directory, directory + "/files/" + UUID);
        return run(["sh", root() + "/tools/check-layout.sh", UUID, "files"], directory);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function remove(path) {
    GLib.spawn_sync(null, ["rm", "-rf", path], null, GLib.SpawnFlags.SEARCH_PATH, null);
}

function refuses(what, change) {
    let result = overTree(change);
    Harness.ok(result.status !== 0, what + " is refused: " + result.output);
    Harness.ok(result.output.indexOf("layout FAIL") >= 0,
               "and says so as a layout failure: " + result.output);
}

var cases = {};

cases["the tree this repository ships passes"] = function () {
    /* First, so that a failure below is about the change that was made and
     * not about the copy it was made to. */
    let result = overTree(null);
    Harness.equal(result.status, 0, "the payload as it stands: " + result.output);
    Harness.ok(result.output.indexOf("layout ok") >= 0,
               "and says so: " + result.output);
};

cases["a runtime asset that is not there is refused"] = function () {
    /* Every entry of the top level list, one at a time. Read out of the script
     * rather than written out here: a list in this file would be the second
     * copy of the one the script was just made to stop having. */
    let script = Harness.readFile(root() + "/tools/check-layout.sh");
    let declared = /RUNTIME_ENTRIES="([^"]*)"/.exec(script);
    Harness.ok(declared !== null, "the script says what the top level holds");
    let entries = declared[1].split(/\s+/).filter(name => name !== "");
    Harness.ok(entries.length > 5, "and there are " + entries.length + " of them");
    for (let name of entries)
        refuses("a payload with no " + name, (tree, xlet) => remove(xlet + "/" + name));
};

cases["anything else at the top level of the payload is refused"] = function () {
    refuses("a file the runtime does not expect", (tree, xlet) =>
        GLib.file_set_contents(xlet + "/notes.txt", "left behind\n"));
    refuses("a directory the runtime does not expect", (tree, xlet) =>
        GLib.mkdir_with_parents(xlet + "/scratch", 0o755));
    refuses("a hidden file", (tree, xlet) =>
        GLib.file_set_contents(xlet + "/.eslintrc", "{}\n"));
};

cases["files/ holds the payload directory and nothing else"] = function () {
    refuses("a second directory beside the payload", tree =>
        GLib.mkdir_with_parents(tree + "/files/another@example", 0o755));
    refuses("a file beside the payload", tree =>
        GLib.file_set_contents(tree + "/files/README", "no\n"));
};

cases["a missing wrapper asset is refused"] = function () {
    for (let name of ["info.json", "README.md", "screenshot.png"])
        refuses("a tree with no " + name, tree => remove(tree + "/" + name));
};

cases["development artifacts anywhere in the payload are refused"] = function () {
    /* Anywhere, not at the top: the top level list would already refuse these
     * beside applet.js, and the mistake this rule is for is a directory
     * further down that a shallower check walks straight past. */
    refuses("a todo file under lib/", (tree, xlet) =>
        GLib.file_set_contents(xlet + "/lib/todo.md", "not shipped\n"));
    refuses("a test directory under ui/", (tree, xlet) => {
        GLib.mkdir_with_parents(xlet + "/ui/tests", 0o755);
        GLib.file_set_contents(xlet + "/ui/tests/keep", "");
    });
    refuses("compiled Python beside a library", (tree, xlet) =>
        GLib.file_set_contents(xlet + "/lib/helper.pyc", ""));
};

cases["metadata that does not describe this payload is refused"] = function () {
    function metadataWith(change) {
        return (tree, xlet) => {
            let metadata = JSON.parse(Harness.readFile(xlet + "/metadata.json"));
            change(metadata);
            GLib.file_set_contents(xlet + "/metadata.json", JSON.stringify(metadata));
        };
    }
    refuses("metadata naming another applet",
            metadataWith(metadata => { metadata.uuid = "other@example"; }));
    refuses("metadata with no name",
            metadataWith(metadata => { delete metadata.name; }));
    refuses("metadata with no description",
            metadataWith(metadata => { delete metadata.description; }));

    /* The three Spices rejects a submission for. They are absent, and this is
     * what keeps them absent. */
    for (let field of ["icon", "dangerous", "last-edited"]) {
        refuses("metadata carrying " + field,
                metadataWith(metadata => { metadata[field] = "x"; }));
    }
};

cases["an info.json author Spices cannot use is refused"] = function () {
    function infoWith(author) {
        return tree => {
            let info = JSON.parse(Harness.readFile(tree + "/info.json"));
            if (author === null)
                delete info.author;
            else
                info.author = author;
            GLib.file_set_contents(tree + "/info.json", JSON.stringify(info));
        };
    }
    refuses("an author with a space in it", infoWith("Geraldo Netto"));
    refuses("an empty author", infoWith(""));
    refuses("no author at all", infoWith(null));
};

cases["an icon that is not a square PNG is refused"] = function () {
    refuses("an icon that is not a PNG at all", (tree, xlet) =>
        GLib.file_set_contents(xlet + "/icon.png", "not an image\n"));
    refuses("a PNG that is not square", (tree, xlet) => {
        /* A real header, with a width and a height that differ. What follows
         * it does not matter: the gate reads the first twenty-four bytes. */
        let header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
                      0, 0, 0, 64, 0, 0, 0, 32];
        GLib.file_set_contents(xlet + "/icon.png", Uint8Array.from(header));
    });
};

cases["the gate is what make check and the packaging tool both run"] = function () {
    let makefile = Harness.readFile(root() + "/Makefile");
    Harness.ok(makefile.indexOf('sh tools/check-layout.sh "$(UUID)" "$(FILES_DIR)"') >= 0,
               "make check runs it over the working tree");
    let packager = Harness.readFile(root() + "/tools/build-package.py");
    Harness.ok(packager.indexOf('"tools/check-layout.sh"') >= 0,
               "and the packaging tool runs it before it writes an archive");
};
