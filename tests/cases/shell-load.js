/*
 * The third of the applet nothing here can load, loaded.
 *
 * applet.js and the modules under ui/ build Cinnamon widgets, so the harness
 * cannot require them and the coverage run cannot measure them - and every
 * other case that holds them to anything holds them as text. What that leaves
 * out is the failure that is neither bad syntax nor an unresolved name: a
 * require of a moved file, a class extending an export that is gone, a top
 * level constant read off a library under a name it no longer has. All of
 * those load cleanly through the parse check and the scope check and then
 * throw the moment Cinnamon evaluates the file, on a user's panel.
 *
 * tools/shell-load.sh puts the installed Cinnamon on cjs's import and typelib
 * paths and evaluates the real files through the same loader emulation the
 * harness uses, so what it proves is about the shell and not about a stub.
 * It needs a Cinnamon to be installed, which the CI runner has not got; that
 * is a skip with a reason on it, printed by name at the end of every run,
 * rather than a gate that reports success where it never ran.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

/* The exit status the tool uses for "there is no Cinnamon on this machine",
 * as opposed to 1, which is the applet's own code failing to load. */
const UNAVAILABLE = 2;

var cases = {};

cases["every shell source loads in a real Cinnamon"] = function () {
    let script = Harness.testsDir() + "/../tools/shell-load.sh";
    Harness.ok(GLib.file_test(script, GLib.FileTest.EXISTS),
               "the shell loader is where the case expects it");

    let outcome = Harness.settle(done => Privileged._spawn(
        ["sh", script],
        (status, stderr, stdout) => done({
            status: status, stderr: stderr || "", stdout: stdout || "",
        })), "the shell load");

    if (outcome.status === UNAVAILABLE)
        Harness.skip(outcome.stdout.trim() || "no Cinnamon on this machine");

    Harness.equal(outcome.status, 0,
                  "applet.js and every ui/ module load:\n" +
                  outcome.stdout + outcome.stderr);
    Harness.ok(outcome.stdout.indexOf("shell ok") >= 0,
               "the loader says what it loaded: " + outcome.stdout);
};

/*
 * The count in that message is the reason it can be trusted. A loader that
 * found no files would report every one of nothing as loaded and exit 0, so
 * what is held here is that the number it reports is the number of shell
 * sources this tree actually has.
 */
cases["the shell load covers applet.js and every widget module"] = function () {
    let expected = Harness.shellModules().length + 1;
    Harness.ok(expected > 1, "there are widget modules beside applet.js");

    let outcome = Harness.settle(done => Privileged._spawn(
        ["sh", Harness.testsDir() + "/../tools/shell-load.sh"],
        (status, stderr, stdout) => done({
            status: status, stdout: stdout || "",
        })), "the shell load");

    if (outcome.status === UNAVAILABLE)
        Harness.skip((outcome.stdout.trim() || "no Cinnamon on this machine"));

    Harness.ok(outcome.stdout.indexOf("shell ok     " + expected + " sources") >= 0,
               "all " + expected + " shell sources were loaded: " + outcome.stdout);
};

/*
 * The skip, held to what it is allowed to mean.
 *
 * A gate that answers "not applicable here" is worth exactly the narrowness
 * of the condition it says that under. This one said it whenever anything it
 * needed was missing, so a Cinnamon whose typelibs are not where the search
 * expects - a distribution laying them out differently, a partial install -
 * reported no Cinnamon at all, and the applet's shell sources went unevaluated
 * on the only kind of machine that can evaluate them, with a green run to show
 * for it.
 *
 * Pointed at a directory that looks like a Cinnamon JavaScript tree and is
 * not one, the loader must answer something - loaded or failed - rather than
 * excuse itself. Runs the same way on a runner, where the typelibs really are
 * absent and that too is now an answer.
 */
cases["a directory that claims to be Cinnamon is never a skip"] = function () {
    let directory = GLib.dir_make_tmp("powertoys-shell-load-case-XXXXXX");
    try {
        GLib.mkdir_with_parents(directory + "/ui", 0o755);
        let outcome = Harness.settle(done => Privileged._spawn(
            ["env", "POWERTOYS_CINNAMON_JS=" + directory,
             "sh", Harness.testsDir() + "/../tools/shell-load.sh"],
            (status, stderr, stdout) => done({
                status: status, output: (stdout || "") + (stderr || ""),
            })), "the shell load");

        Harness.ok(outcome.status !== UNAVAILABLE,
                   "a Cinnamon that is there is answered, not skipped: " +
                   outcome.output);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
};
