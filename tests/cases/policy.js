/* The polkit action is a grant of root, so what matters is not that it parses
 * but that it cannot be widened without the build saying so. These cases run
 * the shipped action through the checker, and then run deliberately widened
 * copies of it through the same checker to prove each refusal is real. */

const GLib = imports.gi.GLib;
const Harness = imports.harness;

const Privileged = Harness.requireXlet("./lib/privileged.js");

const HELPER = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";
const POLICY = "polkit/io.github.geraldo-netto.cinnamon-powertoys.policy";

function policyPath() {
    return Harness.testsDir() + "/../" + POLICY;
}

function checker() {
    return Harness.testsDir() + "/../tools/check-policy.py";
}

/* Runs the checker over a copy of the shipped action with one substitution
 * applied, so each case differs from the accepted file in exactly one way. */
function check(replacements) {
    let source = Harness.readFile(policyPath());
    for (let [from, to] of replacements || []) {
        Harness.ok(source.indexOf(from) >= 0, "the action still contains " + from);
        source = source.replace(from, to);
    }
    let directory = GLib.dir_make_tmp("powertoys-policy-check-XXXXXX");
    try {
        let path = directory + "/action.policy";
        GLib.file_set_contents(path, source);
        return Harness.settle(done => Privileged._spawn(
            ["python3", checker(), path, HELPER],
            (status, stderr) => done({ status: status, stderr: stderr })),
        "the policy check");
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

var cases = {};

cases["the shipped action passes its own check"] = function () {
    let result = check([]);
    Harness.equal(result.status, 0, "the action as shipped is accepted: " + result.stderr);
};

cases["the action refuses callers that are not logged in at this machine"] = function () {
    let source = Harness.readFile(policyPath());
    Harness.ok(source.indexOf("<allow_any>no</allow_any>") >= 0,
               "a caller with no session is refused outright");
    Harness.ok(source.indexOf("<allow_inactive>no</allow_inactive>") >= 0,
               "so is an inactive one");
    Harness.ok(source.indexOf("<allow_active>auth_admin_keep</allow_active>") >= 0,
               "and the active session still authenticates, keeping it for a few minutes");
};

cases["an authentication offered to a remote caller fails the check"] = function () {
    let result = check([["<allow_any>no</allow_any>",
                         "<allow_any>auth_admin</allow_any>"]]);
    Harness.ok(result.status !== 0, "allow_any may not authenticate");
    Harness.ok(result.stderr.indexOf("allow_any") >= 0, "and the failure names it");
};

cases["an authentication offered to an inactive caller fails the check"] = function () {
    let result = check([["<allow_inactive>no</allow_inactive>",
                         "<allow_inactive>auth_admin</allow_inactive>"]]);
    Harness.ok(result.status !== 0, "allow_inactive may not authenticate");
    Harness.ok(result.stderr.indexOf("allow_inactive") >= 0, "and the failure names it");
};

cases["granting either of them outright fails the check"] = function () {
    let result = check([["<allow_any>no</allow_any>", "<allow_any>yes</allow_any>"]]);
    Harness.ok(result.status !== 0, "an unauthenticated grant is worse, not better");
};

cases["dropping the active session's authentication fails the check"] = function () {
    let result = check([["<allow_active>auth_admin_keep</allow_active>",
                         "<allow_active>yes</allow_active>"]]);
    Harness.ok(result.status !== 0, "a privileged change always authenticates");
    Harness.ok(result.stderr.indexOf("allow_active") >= 0, "and the failure names it");
};

cases["the discouraged display forwarding is absent and stays absent"] = function () {
    let source = Harness.readFile(policyPath());
    Harness.ok(source.indexOf('<annotate key="org.freedesktop.policykit.exec.allow_gui"') < 0,
               "the helper draws nothing, so no display is forwarded into root");
    Harness.ok(source.indexOf("exec.allow_gui") >= 0,
               "and the action says why it is absent, so it is not reintroduced as an oversight");
    let result = check([
        ['<annotate key="org.freedesktop.policykit.exec.path">',
         '<annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate>\n' +
         '    <annotate key="org.freedesktop.policykit.exec.path">'],
    ]);
    Harness.ok(result.status !== 0, "reintroducing it fails the check");
    Harness.ok(result.stderr.indexOf("allow_gui") >= 0, "and the failure names it");
};

cases["the action may only authorise the installed helper"] = function () {
    let result = check([[HELPER, "/tmp/powertoys-helper"]]);
    Harness.ok(result.status !== 0, "another executable is not this action's to run");
    Harness.ok(result.stderr.indexOf("exec.path") >= 0, "and the failure names the annotation");
};

cases["an action that names no executable fails the check"] = function () {
    let result = check([
        ['<annotate key="org.freedesktop.policykit.exec.path">' + HELPER + "</annotate>", ""],
    ]);
    Harness.ok(result.status !== 0, "an action without exec.path authorises nothing safely");
};

cases["the check is what make check runs"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    Harness.ok(source.indexOf("POLICY_CHECKER := tools/check-policy.py") >= 0,
               "the checker is named once");
    Harness.ok(source.indexOf("python3 $(POLICY_CHECKER) polkit/$(POLICY) $(HELPER_PATH)") >= 0,
               "and check runs it over the shipped action with the runtime helper path");
    Harness.ok(source.indexOf("xml.dom.minidom") < 0,
               "the parse-only check it replaced is gone, so both cannot disagree");
};
