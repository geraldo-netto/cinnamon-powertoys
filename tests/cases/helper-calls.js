/*
 * When a privileged call is worth interrupting somebody for.
 *
 * These five were methods on the applet, so the one part of the failure path a
 * user ever meets could only be seen by opening a session and breaking a
 * helper. They are ports and a policy here, and the policy is what the cases
 * below are about: who is told what, when nobody is told anything, and what
 * happens to a call the applet is no longer there to hear the answer to.
 */

const Harness = imports.harness;

const HelperCalls = Harness.requireXlet("./lib/helper-calls.js");

var cases = {};

/*
 * A rig with every port recorded and the helper's answer under the case's
 * control - including "never", which is a shape the applet has to survive and
 * a live helper will not reproduce on demand.
 */
function rig(options) {
    options = options || {};
    let log = {
        notified: [],
        errors: [],
        accepted: 0,
        settled: 0,
        closed: 0,
        ran: [],
        answer: null,
    };
    let calls = new HelperCalls.HelperCalls({
        helper: {
            run: (args, onDone) => {
                log.ran.push(args);
                log.answer = onDone;
                if (options.outcome !== undefined)
                    onDone(options.outcome);
            },
        },
        notifications: {
            notify: (title, body) => log.notified.push([title, body]),
            error: (title, body) => log.errors.push([title, body]),
        },
        allowed: () => options.allowed !== false,
        gone: () => !!options.gone,
        settled: () => { log.settled += 1; },
        accepted: () => { log.accepted += 1; },
        closeMenu: () => { log.closed += 1; },
    });
    return { calls: calls, log: log };
}

cases["a call nobody has allowed answers without reaching the helper"] = function () {
    let it = rig({ allowed: false });
    let seen = [];
    it.calls.call(["governor", "powersave"], {
        accepted: () => { throw new Error("the gate should have refused first"); },
    }, outcome => seen.push(outcome));

    Harness.equal(it.log.ran.length, 0, "no helper was launched");
    Harness.equal(it.log.closed, 0, "and no menu was dropped for a dialog nobody will see");
    Harness.equal(seen.length, 1, "the caller was still answered exactly once");
    Harness.equal(seen[0].applied, false, "and told the change did not happen");
    Harness.ok(seen[0].error, "with a reason in words");
};

cases["a refusal the setting caused names the setting"] = function () {
    let it = rig({ allowed: false });
    it.calls.run(["governor", "powersave"]);
    Harness.equal(it.log.errors.length, 1, "the refusal was reported");
    Harness.equal(it.log.errors[0][1], "Privileged controls are turned off",
                  "in the words of the one refusal that knows exactly why, rather than " +
                  "the general sentence: " + it.log.errors[0][1]);

    let quiet = rig({ allowed: false });
    let seen = null;
    quiet.calls.quietly(["platform-profile", "balanced"], outcome => { seen = outcome; });
    Harness.equal(seen.error, "Privileged controls are turned off",
                  "and the caller reporting in its own words gets the same sentence");
};

cases["a call the gate allows drops the menu before the password dialog"] = function () {
    let it = rig({ outcome: { applied: true } });
    it.calls.call(["boost", "1"], {});

    Harness.equal(it.log.accepted, 0, "no accepted handler was given, so none ran");
    Harness.equal(it.log.closed, 1, "the modal grab was dropped before the spawn");
    Harness.equal(it.log.settled, 1, "and the reading was marked stale when it answered");
};

cases["an outcome arriving after the applet has gone is dropped"] = function () {
    let it = rig({ gone: true });
    let log = it.log;
    let seen = 0;
    it.calls.call(["boost", "1"], {}, () => { seen += 1; });
    Harness.equal(log.ran.length, 1, "the helper was launched");
    log.answer({ applied: true });
    Harness.equal(seen, 0, "but nothing was drawn or reported into an applet that is gone");
    Harness.equal(log.settled, 0, "and no redraw was asked for");
};

cases["an applied change is named rather than left to be inferred"] = function () {
    let it = rig({ outcome: { applied: true } });
    it.calls.run(["governor", "powersave"]);

    Harness.equal(it.log.accepted, 1, "the menu was told a write was under way");
    Harness.equal(it.log.notified.length, 1, "and the user was told what changed");
    Harness.ok(/powersave|Power ?[Ss]ave/i.test(it.log.notified[0][1]),
               "in words naming the governor: " + it.log.notified[0][1]);
    Harness.equal(it.log.errors.length, 0, "nothing was reported as a failure");
};

cases["a change with nothing to say about it says nothing"] = function () {
    let it = rig({ outcome: { applied: true } });
    it.calls.run(["something-else", "1"]);
    Harness.equal(it.log.notified.length, 0,
                  "an argument list with no sentence for it is not announced empty");
};

cases["a change the user cancelled is not reported back to them"] = function () {
    let it = rig({ outcome: { applied: false, cancelled: true, code: "cancelled" } });
    it.calls.run(["boost", "0"]);
    Harness.equal(it.log.errors.length, 0, "the user knows; they did it");
    Harness.equal(it.log.notified.length, 0, "and nothing is announced either");
};

cases["a change that failed is reported in words about its code"] = function () {
    let it = rig({ outcome: { applied: false, code: "unsupported" } });
    it.calls.run(["boost", "1"]);
    Harness.equal(it.log.errors.length, 1, "the failure was reported");
    Harness.ok(it.log.errors[0][1].indexOf("not supported") >= 0,
               "in words about that code: " + it.log.errors[0][1]);
};

cases["an outdated helper is said beside a change that worked"] = function () {
    let it = rig({ outcome: { applied: true, warningCode: "stale-system-helper" } });
    it.calls.run(["boost", "1"]);
    Harness.equal(it.log.errors.length, 1, "the warning was reported");
    Harness.ok(it.log.errors[0][1].indexOf("outdated") >= 0,
               "and it names what is out of date: " + it.log.errors[0][1]);
    Harness.equal(it.log.notified.length, 1, "the change itself is still announced");
};

cases["a quiet call reports nothing and hands the sentence back"] = function () {
    let it = rig({ outcome: { applied: false, code: "unavailable" } });
    let seen = null;
    it.calls.quietly(["profile", "balanced"], outcome => { seen = outcome; });

    Harness.equal(it.log.errors.length, 0, "the tray was left alone");
    Harness.equal(it.log.accepted, 0, "and no menu state was changed on acceptance");
    Harness.ok(seen && seen.error, "the caller got the sentence to say in its own words");
    Harness.equal(seen.applied, false, "along with the outcome it is about");
};

cases["a quiet call that worked is handed back unchanged"] = function () {
    let outcome = { applied: true };
    let it = rig({ outcome: outcome });
    let seen = null;
    it.calls.quietly(["profile", "balanced"], answer => { seen = answer; });
    Harness.equal(seen, outcome, "there is nothing to explain about a change that happened");
};

cases["a profile that would not switch is reported without its D-Bus name"] = function () {
    let it = rig();
    it.calls.profileError("performance", new Error(
        "GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: not permitted"));
    Harness.equal(it.log.errors.length, 1, "the failure was reported");
    Harness.equal(it.log.errors[0][1].indexOf("GDBus"), -1,
                  "with nothing about GDBus in it: " + it.log.errors[0][1]);
};

cases["every message goes out under the applet's own name"] = function () {
    let it = rig({ outcome: { applied: true, warningCode: "stale-system-helper" } });
    it.calls.run(["boost", "1"]);
    it.calls.profileError("balanced", new Error("no"));
    for (let entry of it.log.notified.concat(it.log.errors))
        Harness.equal(entry[0], "Power Toys", "the notification says who it is from");
};

cases["a call with no ports at all does not throw"] = function () {
    let calls = new HelperCalls.HelperCalls();
    let seen = null;
    calls.call(["boost", "1"], {}, outcome => { seen = outcome; });
    Harness.ok(seen && seen.applied === false,
               "the default gate refuses, which is the only answer with no helper to ask");
    calls.reportWarning({ warningCode: "stale-system-helper" });
    calls.profileError("balanced", new Error("no"));
};
