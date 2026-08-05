/* The user install is prepared beside the live applet and rolled back as one
 * operation. These cases run a private copy with a tiny applet tree and a
 * stand-in translation installer, never the user's Cinnamon directory. */

const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const UUID = "cinnamon-powertoys@geraldo-netto";

function read(path) {
    let bytes;
    try {
        let result = GLib.file_get_contents(path);
        bytes = result[1];
    } catch (error) {
        return null;
    }
    return ByteArray.toString(bytes).trim();
}

function scratch(options, body) {
    let directory = GLib.dir_make_tmp("powertoys-install-XXXXXX");
    let source = directory + "/source";
    let applet = source + "/" + UUID;
    let tools = source + "/tools";
    let stage = directory + "/stage";
    let parent = stage + "/share/cinnamon/applets";
    let target = parent + "/" + UUID;
    GLib.mkdir_with_parents(applet, 0o755);
    GLib.mkdir_with_parents(tools, 0o755);
    GLib.mkdir_with_parents(target, 0o755);
    try {
        GLib.file_set_contents(source + "/install.sh",
                               Harness.readFile(Harness.testsDir() + "/../install.sh"));
        GLib.chmod(source + "/install.sh", 0o700);

        for (let name of ["applet.js", "metadata.json", "settings-schema.json",
                          "powertoys-helper"])
            GLib.file_set_contents(applet + "/" + name, "new " + name + "\n");
        GLib.chmod(applet + "/powertoys-helper", 0o600);
        if (!options.incomplete)
            GLib.mkdir_with_parents(applet + "/lib", 0o755);

        GLib.file_set_contents(target + "/marker", "old\n");
        GLib.file_set_contents(tools + "/install-translations.sh",
                               "#!/bin/sh\nexit " + (options.translationStatus || 0) + "\n");
        GLib.chmod(tools + "/install-translations.sh", 0o700);

        let path = GLib.getenv("PATH") || "/usr/bin:/bin";
        if (options.rmdirStatus) {
            let bin = directory + "/bin";
            GLib.mkdir_with_parents(bin, 0o755);
            GLib.file_set_contents(bin + "/rmdir",
                                   "#!/bin/sh\nexit " + options.rmdirStatus + "\n");
            GLib.chmod(bin + "/rmdir", 0o700);
            path = bin + ":" + path;
        }

        return body({ directory: directory, source: source, stage: stage,
                      parent: parent, target: target, path: path });
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function install(tree) {
    return Harness.settle(done => Privileged._spawn([
        "env", "PATH=" + tree.path, "DESTDIR=" + tree.stage, "PREFIX=/share",
        tree.source + "/install.sh",
    ], (status, stderr) => done({ status: status, stderr: stderr })), "the staged install");
}

function temporaryEntries(tree) {
    let entries = [];
    let directory = imports.gi.Gio.File.new_for_path(tree.parent);
    let enumerator = directory.enumerate_children("standard::name",
        imports.gi.Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_name().indexOf("." + UUID + ".") === 0)
            entries.push(info.get_name());
    }
    enumerator.close(null);
    return entries;
}

var cases = {};

cases["an incomplete staged applet leaves the live install untouched"] = function () {
    scratch({ incomplete: true }, tree => {
        let outcome = install(tree);
        Harness.ok(outcome.status !== 0, "validation refused the copy");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior applet is still live");
        Harness.deepEqual(temporaryEntries(tree), [], "the private copy was cleaned up");
    });
};

cases["a failure after the swap restores the previous applet"] = function () {
    scratch({ translationStatus: 7 }, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 7, "the later failure is preserved");
        Harness.equal(read(tree.target + "/marker"), "old", "the prior tree was restored");
        Harness.equal(read(tree.target + "/applet.js"), null, "the replacement was removed");
        Harness.deepEqual(temporaryEntries(tree), [], "neither staging nor backup was stranded");
    });
};

cases["a failed backup reservation cannot replace the live applet"] = function () {
    scratch({ rmdirStatus: 9 }, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 9, "the reservation failure is preserved");
        Harness.equal(read(tree.target + "/marker"), "old", "the live tree was never moved");
        Harness.equal(read(tree.target + "/applet.js"), null, "an empty backup was not restored");
        Harness.deepEqual(temporaryEntries(tree), [], "the failed reservation was cleaned up");
    });
};

cases["a complete staged applet replaces the previous tree"] = function () {
    scratch({}, tree => {
        let outcome = install(tree);
        Harness.equal(outcome.status, 0, "the install completed");
        Harness.equal(read(tree.target + "/applet.js"), "new applet.js", "the new tree is live");
        Harness.equal(read(tree.target + "/marker"), null, "the old tree was retired");
        Harness.equal(GLib.file_test(tree.target + "/powertoys-helper",
                                    GLib.FileTest.IS_EXECUTABLE), true,
                      "the helper was validated and made executable before the swap");
        Harness.deepEqual(temporaryEntries(tree), [], "the backup was removed after commit");
    });
};
