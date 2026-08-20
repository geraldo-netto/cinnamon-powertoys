/* The release archive. What is worth holding is that two builds of the same
 * commit are the same bytes - otherwise the checksum published beside it says
 * only which machine built it - and that what goes in is the payload a user
 * receives and none of the tooling that produced it. */

const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const UUID = "cinnamon-powertoys@geraldo-netto";
const HELPER = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";
const POLICY = "polkit/io.github.geraldo-netto.cinnamon-powertoys.policy";

function root() {
    return Harness.testsDir() + "/..";
}

function build(output, options) {
    let settings = options || {};
    let argv = ["python3", root() + "/tools/build-package.py",
                "--root", settings.root || root(),
                "--uuid", UUID,
                "--policy", settings.policy || POLICY,
                "--helper", settings.helper || HELPER,
                "--output", output];
    return Harness.settle(done => Privileged._spawn(argv, (status, stderr, stdout) => done({
        status: status, stderr: stderr, stdout: stdout || "",
    })), "the package build");
}

function temporary(body) {
    let directory = GLib.dir_make_tmp("powertoys-package-XXXXXX");
    try {
        return body(directory);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function checksum(directory) {
    let listing = Gio_children(directory).filter(name => name.substr(-7) === ".sha256");
    Harness.equal(listing.length, 1, "one checksum was written");
    let [, bytes] = GLib.file_get_contents(directory + "/" + listing[0]);
    return ByteArray.toString(bytes).trim();
}

function Gio_children(directory) {
    let names = [];
    let folder = imports.gi.Gio.File.new_for_path(directory);
    let entries = folder.enumerate_children("standard::name",
        imports.gi.Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null)
        names.push(info.get_name());
    entries.close(null);
    return names.sort();
}

/* Reads the archive's member names and their recorded modes with the unzip
 * the runner already has, so nothing here has to implement the format.
 *
 * A missing unzip is a failure and not a skip, for the reason the Makefile
 * gives about shellcheck and flake8: everything below - what the archive
 * carries, what it leaves out, which entry is executable - is read through
 * this one call, so a skip here retires the release gate entirely and says
 * "ok" while doing it. */
function entries(archive) {
    let result = Harness.settle(done => Privileged._spawn(
        ["unzip", "-Z", "-l", archive],
        (status, stderr, stdout) => done({ status: status, stderr: stderr,
                                           stdout: stdout || "" })),
        "the archive listing");
    if (result.status !== 0)
        Harness.fail("unzip is needed to read the archive: " + (result.stderr || ""));
    return result.stdout.split("\n")
        .map(line => line.trim())
        .filter(line => line !== "" && line.indexOf(UUID + "/") >= 0)
        .map(line => {
            let parts = line.split(/\s+/);
            return { mode: parts[0], name: parts[parts.length - 1] };
        });
}

var cases = {};

cases["the same commit builds the same archive twice"] = function () {
    temporary(directory => {
        let first = build(directory + "/one");
        Harness.equal(first.status, 0, "the first build succeeded: " + first.stderr);
        let second = build(directory + "/two");
        Harness.equal(second.status, 0, "the second build succeeded: " + second.stderr);
        Harness.equal(checksum(directory + "/one").split(" ")[0],
                      checksum(directory + "/two").split(" ")[0],
                      "and both produced the same bytes");
    });
};

cases["the checksum describes the archive beside it"] = function () {
    temporary(directory => {
        let output = directory + "/dist";
        Harness.equal(build(output).status, 0, "the archive was built");
        let listing = Gio_children(output);
        Harness.deepEqual(listing,
                          [UUID + "-1.0.0.zip", UUID + "-1.0.0.zip.sha256"],
                          "the archive is named for the UUID and the metadata version");
        let recorded = checksum(output);
        Harness.equal(recorded.split(/\s+/)[1], UUID + "-1.0.0.zip",
                      "the checksum names the file it is for");
        let verified = Harness.settle(done => Privileged._spawn(
            ["sh", "-c", 'cd "$1" && sha256sum -c ./*.sha256', "verify", output],
            (status, stderr) => done({ status: status, stderr: stderr })),
            "the checksum verification");
        Harness.equal(verified.status, 0, "and it verifies: " + verified.stderr);
    });
};

cases["the archive carries the payload and the wrapper assets only"] = function () {
    temporary(directory => {
        let output = directory + "/dist";
        Harness.equal(build(output).status, 0, "the archive was built");
        let members = entries(output + "/" + UUID + "-1.0.0.zip");
        let names = members.map(member => member.name);

        for (let expected of [UUID + "/info.json", UUID + "/README.md",
                              UUID + "/screenshot.png",
                              UUID + "/files/" + UUID + "/applet.js",
                              UUID + "/files/" + UUID + "/metadata.json",
                              UUID + "/files/" + UUID + "/lib/sensors.js",
                              UUID + "/files/" + UUID + "/po/" + UUID + ".pot"])
            Harness.ok(names.indexOf(expected) >= 0, "the archive ships " + expected);

        for (let name of names) {
            Harness.ok(name.indexOf(UUID + "/") === 0,
                       name + " is under the single top-level directory");
            for (let development of ["/tools/", "/tests/", "/polkit/", "/udev/",
                                     "todo.md", "AGENTS.md", "Makefile", ".coverage"])
                Harness.ok(name.indexOf(development) < 0,
                           name + " is not a development artifact");
        }
    });
};

cases["the helper stays executable and nothing else becomes so"] = function () {
    temporary(directory => {
        let output = directory + "/dist";
        Harness.equal(build(output).status, 0, "the archive was built");
        for (let member of entries(output + "/" + UUID + "-1.0.0.zip")) {
            let executable = member.mode.indexOf("x") >= 0;
            Harness.equal(executable, member.name.substr(-16) === "powertoys-helper",
                          member.name + " is executable only if it is the helper");
        }
    });
};

cases["a release cannot be cut from a tree the checks reject"] = function () {
    temporary(directory => {
        /* A working copy of the tree whose action grants more than it may.
         * The build has to refuse it rather than package it. Only what the
         * build reads is copied - a whole-tree copy would carry the history
         * and the coverage output through every run of this case. */
        let copy = directory + "/tree";
        GLib.mkdir_with_parents(copy, 0o755);
        let copied = Harness.settle(done => Privileged._spawn(
            ["sh", "-c",
             'cd "$1" && cp -R files polkit tools info.json README.md screenshot.png "$2"',
             "tree-copy", root(), copy],
            (status, stderr) => done({ status: status, stderr: stderr })), "the tree copy");
        Harness.equal(copied.status, 0, "the tree was copied: " + copied.stderr);

        let action = copy + "/" + POLICY;
        let source = Harness.readFile(action);
        GLib.file_set_contents(action,
            source.replace("<allow_any>no</allow_any>", "<allow_any>yes</allow_any>"));
        let widened = build(directory + "/dist", { root: copy });
        Harness.ok(widened.status !== 0, "a widened action fails the build");

        GLib.file_set_contents(action, source);
        let helper = build(directory + "/dist", { root: copy, helper: "/tmp/helper" });
        Harness.ok(helper.status !== 0,
                   "and so does an action that authorises another executable");
    });
};

cases["the release target and its job are wired to the tool"] = function () {
    let makefile = Harness.readFile(root() + "/Makefile");
    Harness.ok(makefile.indexOf("PACKAGE_TOOL := tools/build-package.py") >= 0,
               "the Makefile names the packaging tool once");
    Harness.ok(/^dist:$/m.test(makefile), "and exposes it as make dist");
    Harness.ok(makefile.indexOf("rm -rf $(DIST_DIR)") >= 0,
               "which starts from an empty output directory");

    let workflow = Harness.readFile(root() + "/.github/workflows/check.yml");
    Harness.ok(/^ {2}package:$/m.test(workflow), "the workflow builds the package");
    Harness.ok(workflow.indexOf("make dist") >= 0, "with the same target");
    Harness.ok(workflow.indexOf("sha256sum -c") >= 0, "verifies the checksum");
    Harness.ok(workflow.indexOf("install.sh") >= 0 &&
               workflow.indexOf("tools/uninstall.sh") >= 0,
               "and installs and removes the packaged payload");
};
