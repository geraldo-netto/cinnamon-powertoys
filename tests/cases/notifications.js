/* Cinnamon notification failures stay behind one result-returning boundary. */

const Harness = imports.harness;

const Log = Harness.requireXlet("./lib/log.js");
const Notifications = Harness.requireXlet("./lib/notifications.js");

var cases = {};

cases["notification delivery reports success"] = function () {
    let calls = [];
    let center = new Notifications.NotificationCenter({
        notify: (title, body) => calls.push(["normal", title, body]),
        notifyError: (title, body) => calls.push(["error", title, body]),
        criticalNotify: (title, body) => calls.push(["critical", title, body]),
    });

    Harness.equal(center.notify("A", "one"), true, "normal delivery succeeds");
    Harness.equal(center.error("B", "two"), true, "error delivery succeeds");
    Harness.equal(center.critical("C", "three"), true, "critical delivery succeeds");
    Harness.deepEqual(calls, [
        ["normal", "A", "one"], ["error", "B", "two"],
        ["critical", "C", "three"],
    ], "each kind reaches its matching shell method");
};

cases["notification delivery failures are contained"] = function () {
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        let center = new Notifications.NotificationCenter({
            notify: () => { throw new Error("shell unavailable"); },
        });
        Harness.equal(center.notify("A", "one"), false, "a throwing shell reports failure");
        Harness.equal(center.error("B", "two"), false, "a missing method reports failure");
        Harness.equal(lines.length, 2, "both failures are diagnosed without escaping");
    } finally {
        Log.setSink(null);
    }
};

cases["one continuous notification failure is logged once"] = function () {
    let lines = [];
    let failing = true;
    Log.setSink(line => lines.push(line));
    try {
        let center = new Notifications.NotificationCenter({
            notify: () => {
                if (failing)
                    throw new Error("shell unavailable");
            },
        });
        Harness.equal(center.notify("A", "one"), false, "the first attempt fails");
        Harness.equal(center.notify("A", "two"), false, "the retry still fails");
        Harness.equal(lines.length, 1, "one continuous failure has one diagnostic");

        failing = false;
        Harness.equal(center.notify("A", "three"), true, "success closes the failure");
        failing = true;
        Harness.equal(center.notify("A", "four"), false, "a later outage fails again");
        Harness.equal(lines.length, 2, "a later outage receives its own diagnostic");
    } finally {
        Log.setSink(null);
    }
};
