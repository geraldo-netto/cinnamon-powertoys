/*
 * The charge limit and the ACPI platform profile.
 *
 * Both are read out of two or three files and written through a runner, and
 * what is worth pinning about each is the counting: how many batteries agreed,
 * how many choices the firmware offers. The existing cases in sensors.js run
 * these against captured trees; what is here is the boundaries those trees do
 * not happen to sit on - one battery, one choice, none at all - which is where
 * a count read one off draws a control that is missing, dead, or claiming a
 * disagreement between batteries that both said the same thing.
 */

const Harness = imports.harness;
const Fuzz = imports.fuzz;

const PowerSupply = Harness.requireXlet("./lib/power-supply.js");
const IO = Harness.requireXlet("./lib/io.js");

/*
 * A control over batteries that answer whatever this case says, without a
 * file system in the way.
 *
 * The backend discovers its batteries by listing /sys, which these cases are
 * not about, so the list is planted and only the sample is run - which is the
 * one call that turns per-battery values into the reading the menu draws.
 */
function control(limits) {
    let batteries = limits.map((limit, index) => ({ name: "BAT" + index,
                                                    path: "/battery/" + index }));
    let commands = [];
    let real = IO.readStringsAsync;
    IO.readStringsAsync = function (paths, done) {
        let values = {};
        for (let path of paths) {
            let index = Number(path.slice("/battery/".length));
            let limit = Number.isFinite(index) && index < limits.length
                ? limits[index] : null;
            values[path] = limit === null ? null : String(limit);
        }
        done(values);
    };
    let charge = new PowerSupply.ChargeControl((args, onDone) => {
        commands.push(args.join(" "));
        if (onDone)
            onDone({ applied: true });
    });
    charge.batteries = batteries;
    Harness.settle(done => charge.sample(done), "the charge sample");
    charge.commands = commands;
    charge.release = () => {
        IO.readStringsAsync = real;
        charge.destroy();
    };
    return charge;
}

var cases = {};

cases["one battery is a limit, and is not two batteries disagreeing"] = function () {
    let charge = control([80]);
    try {
        let reading = charge.reading();
        Harness.deepEqual(reading.limits, [80], "the one battery");
        Harness.equal(reading.limit, 80, "and its limit is the limit");
        Harness.equal(reading.state, "agreed", "the explicit state");
        Harness.equal(reading.agreed, true, "one complete value agrees");
        Harness.equal(reading.divided, false,
                      "one battery cannot disagree with anything");
        Harness.equal(charge.limit, 80, "the shorthand says the same");
    } finally {
        charge.release();
    }
};

cases["two batteries at the same limit are one limit"] = function () {
    let charge = control([80, 80]);
    try {
        let reading = charge.reading();
        Harness.equal(reading.limit, 80, "both agreed");
        Harness.equal(reading.state, "agreed", "the state says why there is a limit");
        Harness.equal(reading.divided, false, "so there is nothing to explain");
    } finally {
        charge.release();
    }
};

cases["two batteries set apart have no one limit, and say which case it is"] = function () {
    /*
     * The menu draws a note for this and only this. A group of limits with
     * none of them marked reads as a control that has stopped working, so the
     * difference between "no limit" and "two limits" has to reach the caller.
     */
    let charge = control([80, 60]);
    try {
        let reading = charge.reading();
        Harness.equal(reading.limit, null, "no single figure to dot");
        Harness.equal(reading.state, "divided", "all answered, but differently");
        Harness.equal(reading.divided, true, "and the reason is that they differ");
    } finally {
        charge.release();
    }
};

cases["a battery that will not answer is not a battery that disagrees"] = function () {
    /*
     * A node that is busy or gone reads as null, and null is not a limit. What
     * must not happen is the note appearing: nothing here says the batteries
     * were set apart, only that one of them did not answer.
     */
    let charge = control([80, null]);
    try {
        let reading = charge.reading();
        Harness.deepEqual(reading.limits, [80, null], "one answered, one did not");
        Harness.equal(reading.limit, null, "so there is no limit to show");
        Harness.equal(reading.state, "incomplete", "the missing answer is explicit");
        Harness.equal(reading.incomplete, true, "and available as a direct predicate");
        Harness.equal(reading.readableCount, 1, "one answer");
        Harness.equal(reading.batteryCount, 2, "from two batteries");
        Harness.equal(reading.divided, false,
                      "and no claim that somebody set them differently");
    } finally {
        charge.release();
    }

    let silent = control([null]);
    try {
        let reading = silent.reading();
        Harness.equal(reading.limit, null, "the only battery said nothing");
        Harness.equal(reading.state, "incomplete", "one missing answer is incomplete too");
        Harness.equal(reading.divided, false, "which is not a disagreement either");
    } finally {
        silent.release();
    }
};

cases["no batteries at all is no limit"] = function () {
    /* A desktop discovers no battery at all, and the control must not read a
     * limit out of an empty list - an undefined drawn into the menu is a dot
     * on nothing. */
    let charge = control([]);
    try {
        let reading = charge.reading();
        Harness.deepEqual(reading.limits, [], "no batteries");
        Harness.equal(reading.limit, null, "no limit");
        Harness.equal(reading.state, "incomplete", "an empty control is incomplete");
        Harness.equal(reading.divided, false, "and nothing to explain");
        Harness.equal(charge.available, false, "and it is not a backend");
    } finally {
        charge.release();
    }
};

cases["the write goes to every battery, in the helper's own word"] = function () {
    let charge = control([80, 60]);
    try {
        charge.setLimit(70);
        Harness.deepEqual(charge.commands, ["charge-threshold 70"],
                          "one command, which the helper applies to all of them");
    } finally {
        charge.release();
    }
};

cases["whatever the batteries say, a reading is a limit or nothing"] = function () {
    /*
     * The property the menu leans on: `limit` is a number every battery
     * agreed on, or null. Anything else - one battery's figure standing for
     * both, or an undefined - is a control that says the machine is set to
     * something it is not.
     */
    Fuzz.forAll({ what: "the charge reading", runs: 400 }, random => {
        let limits = [];
        let count = random.below(4);
        for (let i = 0; i < count; i++)
            limits.push(random.chance(3) ? null : random.between(20, 100));
        return limits;
    }, limits => {
        let charge = control(limits);
        try {
            let reading = Fuzz.answers(() => charge.reading());
            if (reading.limit !== null) {
                if (typeof reading.limit !== "number")
                    throw new Error("a limit of " + String(reading.limit));
                if (!limits.every(value => value === reading.limit))
                    throw new Error("reported " + reading.limit + " for " +
                                    JSON.stringify(limits));
            } else if (limits.length > 0 && limits.every(value => value === limits[0]) &&
                       limits[0] !== null) {
                throw new Error("no limit for " + JSON.stringify(limits));
            }
            if (reading.divided && !(limits.filter(value => value !== null).length > 1))
                throw new Error("claimed a disagreement between " + JSON.stringify(limits));
            let expectedState = limits.length === 0 || limits.some(value => value === null)
                ? "incomplete"
                : limits.every(value => value === limits[0]) ? "agreed" : "divided";
            if (reading.state !== expectedState)
                throw new Error("state " + reading.state + " for " + JSON.stringify(limits));
            if ((reading.state === "agreed") !== reading.agreed ||
                    (reading.state === "divided") !== reading.divided ||
                    (reading.state === "incomplete") !== reading.incomplete)
                throw new Error("state predicates disagree for " + JSON.stringify(limits));
        } finally {
            charge.release();
        }
    });
};

cases["runtime charge discovery and sampling never use synchronous sysfs"] = function () {
    let real = {
        listDir: IO.listDir,
        readString: IO.readString,
        readNumber: IO.readNumber,
        exists: IO.exists,
        listDirAsync: IO.listDirAsync,
        readStringsAsync: IO.readStringsAsync,
        pathsExistAsync: IO.pathsExistAsync,
    };
    let limit = "80";
    let changes = 0;
    let synchronous = () => { throw new Error("synchronous filesystem access"); };
    IO.listDir = synchronous;
    IO.readString = synchronous;
    IO.readNumber = synchronous;
    IO.exists = synchronous;
    IO.listDirAsync = (path, done) => done(["AC", "BAT0"]);
    IO.pathsExistAsync = (paths, done) => done({
        "/sys/class/power_supply/AC/charge_control_end_threshold": false,
        "/sys/class/power_supply/BAT0/charge_control_end_threshold": true,
    });
    IO.readStringsAsync = (paths, done) => {
        let values = {};
        for (let path of paths) {
            if (/\/type$/.test(path))
                values[path] = path.indexOf("BAT0") >= 0 ? "Battery" : "Mains";
            else
                values[path] = limit;
        }
        done(values);
    };

    let client = new PowerSupply.ChargeControl(null, () => changes++);
    try {
        let refreshed = null;
        client.refresh(value => { refreshed = value; });
        Harness.equal(refreshed, true, "topology discovery settles");
        Harness.equal(client.available, true, "the cached topology has a battery");
        Harness.equal(client.reading().limit, 80, "discovery publishes its complete sample");
        Harness.equal(changes, 1, "the new topology is reported");

        limit = "65";
        let sampled = null;
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, true, "the live value sample settles");
        Harness.equal(client.limit, 65, "and replaces the cached value");

        client.destroy();
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, false, "teardown rejects later samples");
    } finally {
        client.destroy();
        for (let name in real)
            IO[name] = real[name];
    }
};

cases["runtime charge work coalesces and rejects stale lifecycle replies"] = function () {
    let commands = [];
    let client = new PowerSupply.ChargeControl(
        (args, done) => { commands.push(args); if (done) done(true); });
    let starts = 0;
    let results = [];
    client._startRefresh = function () {
        starts++;
        this._refreshing = true;
    };
    client.refresh(value => results.push(value));
    client.refresh(value => results.push(value));
    Harness.equal(starts, 1, "overlapping topology requests start one sweep");
    Harness.equal(client._refreshPending, true, "one newer sweep is retained");

    client._finishRefresh([], []);
    Harness.equal(starts, 2, "the retained sweep starts after the first snapshot");
    client._finishRefresh([], []);
    Harness.deepEqual(results, [true, true], "both callers settle after the newer sweep");

    client.batteries = [{ name: "BAT0", path: "/old" }];
    let sampleDone = null;
    client._sampleBatteries = (batteries, done) => { sampleDone = done; };
    client.sample(value => results.push(value));
    client.batteries = [{ name: "BAT1", path: "/new" }];
    sampleDone([80]);
    Harness.equal(results[2], false, "a sample for replaced topology is rejected");

    client.batteries = [{ name: "BAT0", path: "/same" }];
    client._reading = { limit: 60 };
    client.sample(value => results.push(value));
    client._finishRefresh([{ name: "BAT0", path: "/same" }], [75]);
    sampleDone([50]);
    Harness.equal(results[3], false,
                  "a sample cannot overwrite a newer same-topology refresh");
    Harness.equal(client.limit, 75, "the refresh snapshot remains current");

    client.batteries = [{ name: "BAT0", path: "/old" }];
    client.sample(value => results.push(value));
    client.destroy();
    sampleDone([70]);
    Harness.equal(results[4], false, "an in-flight sample settles false at teardown");
    client.refresh(value => results.push(value));
    client.refresh();
    Harness.equal(results[5], false, "later discovery is rejected too");

    let writeResult = null;
    let writer = new PowerSupply.ChargeControl((args, done) => {
        commands.push(args);
        done("written");
    });
    writer.setLimit(75, value => { writeResult = value; });
    Harness.deepEqual(commands[0], ["charge-threshold", "75"], "writes keep the helper protocol");
    Harness.equal(writeResult, "written", "and preserve the runner callback");
    writer.destroy();
};

/* ---------------------------------------------------------------- */
/* the firmware's own profile                                        */

/* A client over a firmware that answers whatever this case says, refreshed
 * once so that the fields the getters read are the ones a poll left. */
function firmware(active, choices) {
    let real = IO.readStringsAsync;
    IO.readStringsAsync = function (paths, done) {
        let values = {};
        for (let path of paths) {
            if (/_choices$/.test(path))
                values[path] = active === null ? null : choices.join(" ");
            else if (/platform_profile$/.test(path))
                values[path] = active;
            else
                values[path] = null;
        }
        done(values);
    };

    let commands = [];
    let client = new PowerSupply.PlatformProfileClient((args, onDone) => {
        commands.push(args.join(" "));
        if (onDone)
            onDone({ applied: true });
    });
    client.commands = commands;
    Harness.settle(done => client.refresh(done), "the firmware profile refresh");
    client.release = function () {
        IO.readStringsAsync = real;
        client.destroy();
    };
    return client;
}

cases["a firmware offering one profile is a firmware with a profile"] = function () {
    /*
     * The count is what decides whether this backend exists at all, and a
     * machine whose firmware offers a single profile does have one - the menu
     * shows it as a reading rather than a choice, which is a decision made
     * further up. Counting from two here would take the whole profile group
     * off the menu and fall back to a daemon that is not running.
     */
    let client = firmware("quiet", ["quiet"]);
    try {
        Harness.equal(client.available, true, "one choice is a choice");
        Harness.deepEqual(client.profiles, ["quiet"], "and it is offered");
        Harness.equal(client.active, "quiet", "with the active one named");

        let snapshot = client.snapshot();
        Harness.equal(snapshot.available, true, "and a whole reading says the same");
        Harness.deepEqual(snapshot.profiles, ["quiet"], "with the same list");
    } finally {
        client.release();
    }
};

cases["a firmware that offers nothing is not a backend"] = function () {
    /* The node exists and its choices are empty, which is what some firmware
     * does while it is still starting up. Nothing to offer is not a backend
     * the applet can use. */
    let client = firmware("balanced", []);
    try {
        Harness.equal(client.available, false, "no choices, no control");
        Harness.equal(client.snapshot().available, false, "and the reading agrees");
    } finally {
        client.release();
    }
};

cases["a machine with no platform profile node answers null rather than throwing"] = function () {
    let client = firmware(null, []);
    try {
        Harness.equal(client.available, false, "nothing there");
        Harness.equal(client.active, null, "no active profile");
        Harness.deepEqual(client.profiles, [], "no list");
        Harness.equal(client.snapshot().active, null, "and a reading says the same");
    } finally {
        client.release();
    }
};

cases["writing a profile answers that it was taken on"] = function () {
    /*
     * The two profile backends wear one face, and part of that face is
     * answering whether the call was taken - the applet's own _setProfile
     * reads it to decide whether there is anything to announce.
     */
    let client = firmware("balanced", ["quiet", "balanced", "performance"]);
    try {
        let taken = client.setProfile("performance", () => {});
        Harness.equal(taken, true, "taken on");
        Harness.deepEqual(client.commands, ["platform-profile performance"],
                          "and sent in the helper's own words");
    } finally {
        client.release();
    }
};

cases["the firmware backend says which backend it is"] = function () {
    /*
     * The menu compares this against the daemon's name to decide whether the
     * governor is anybody's to set: power-profiles-daemon writes cpufreq and
     * this one does not, so under this backend the governor stays a control.
     */
    let client = firmware("balanced", ["balanced"]);
    try {
        Harness.equal(client.busName, PowerSupply.PLATFORM_BACKEND, "its own name");
        Harness.equal(client.snapshot().busName, PowerSupply.PLATFORM_BACKEND,
                      "and the reading carries it");
        Harness.equal(client.degraded, "", "the firmware says nothing about throttling");
        Harness.deepEqual(client.holds, [], "nor about applications holding a profile");
    } finally {
        client.release();
    }
};

cases["the runtime firmware backend discovers and samples asynchronously"] = function () {
    let real = {
        exists: IO.exists,
        readString: IO.readString,
        readWords: IO.readWords,
        readStringsAsync: IO.readStringsAsync,
    };
    let active = "balanced";
    let synchronous = () => { throw new Error("synchronous filesystem access"); };
    IO.exists = synchronous;
    IO.readString = synchronous;
    IO.readWords = synchronous;
    IO.readStringsAsync = (paths, done) => {
        let values = {};
        for (let path of paths)
            values[path] = /choices$/.test(path) ? "quiet balanced performance" : active;
        done(values);
    };

    let changes = 0;
    let client = new PowerSupply.PlatformProfileClient(null, {
        asynchronous: true,
        onChanged: () => changes++,
    });
    try {
        Harness.equal(client.available, false, "nothing is guessed before discovery");
        let refreshed = null;
        client.refresh(value => { refreshed = value; });
        Harness.equal(refreshed, true, "topology discovery settles");
        Harness.equal(client.available, true, "the cached choices make a backend");
        Harness.deepEqual(client.profiles, ["quiet", "balanced", "performance"],
                          "choices are cached from the discovery snapshot");
        Harness.equal(changes, 1, "the first complete snapshot is reported");

        active = "quiet";
        let sampled = null;
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, true, "the active-profile sample settles");
        Harness.equal(client.active, "quiet", "only the moving value is updated");
        Harness.deepEqual(client.profiles, ["quiet", "balanced", "performance"],
                          "sampling preserves topology");

        client.destroy();
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, false, "teardown rejects later active-profile samples");
    } finally {
        client.destroy();
        for (let name in real)
            IO[name] = real[name];
    }
};

cases["a firmware sample that cannot read the node keeps the last profile"] = function () {
    /*
     * IO answers an unsettled path with null and calls back all the same - a
     * cancelled batch, a read that timed out on a slow ACPI node. Written
     * through as the active profile that leaves a machine with a list of
     * profiles and none of them in force, which the menu draws as a control
     * with nothing selected and the panel as no gauge at all. The last
     * complete reading stands instead, and the sample says it did not answer.
     */
    let real = IO.readStringsAsync;
    let active = "balanced";
    IO.readStringsAsync = (paths, done) => {
        let values = {};
        for (let path of paths)
            values[path] = /choices$/.test(path) ? "quiet balanced performance" : active;
        done(values);
    };

    let client = new PowerSupply.PlatformProfileClient(null);
    try {
        client.refresh(function () {});
        Harness.equal(client.active, "balanced", "a complete reading to lose");

        active = null;
        let sampled = null;
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, false, "the sample reports that it did not answer");
        Harness.equal(client.active, "balanced",
                      "the last profile the machine actually reported is kept");
        Harness.deepEqual(client.profiles, ["quiet", "balanced", "performance"],
                          "and the choices with it");
        Harness.equal(client.available, true,
                      "so the backend does not go missing over one unreadable read");

        active = "performance";
        client.sample(value => { sampled = value; });
        Harness.equal(sampled, true, "the next readable sample answers");
        Harness.equal(client.active, "performance", "and is adopted");
    } finally {
        client.destroy();
        IO.readStringsAsync = real;
    }
};

cases["firmware refreshes reject superseded and teardown replies"] = function () {
    let real = IO.readStringsAsync;
    let pending = [];
    IO.readStringsAsync = (paths, done) => pending.push(done);
    try {
        let client = new PowerSupply.PlatformProfileClient(null);
        let results = [];
        client.sample(value => results.push(value));
        Harness.deepEqual(results, [true], "no discovered backend needs no active read");

        client.refresh(value => results.push(value));
        client.refresh(value => results.push(value));
        pending[0]({
            "/sys/firmware/acpi/platform_profile": "quiet",
            "/sys/firmware/acpi/platform_profile_choices": "quiet balanced",
        });
        pending[1]({
            "/sys/firmware/acpi/platform_profile": null,
            "/sys/firmware/acpi/platform_profile_choices": null,
        });
        Harness.deepEqual(results, [true, false, true],
                          "the superseded topology is rejected and the newest is adopted");

        client._profile = { active: "balanced", choices: ["quiet", "balanced"] };
        client.refresh(value => results.push(value));
        client.sample(value => results.push(value));
        Harness.equal(pending.length, 3,
                      "an active sample waits for the in-flight topology refresh");
        pending[2]({
            "/sys/firmware/acpi/platform_profile": "balanced",
            "/sys/firmware/acpi/platform_profile_choices": "quiet balanced performance",
        });
        Harness.equal(pending.length, 4, "the newer active read starts after topology lands");
        pending[3]({ "/sys/firmware/acpi/platform_profile": "performance" });
        Harness.deepEqual(results.slice(3, 5), [true, true],
                          "the ordered refresh and sample both settle");
        Harness.equal(client.active, "performance", "the later active value wins");
        Harness.deepEqual(client.profiles, ["quiet", "balanced", "performance"],
                          "and the refresh still updates profile topology");

        client._profile = { active: "balanced", choices: ["quiet", "balanced"] };
        client.sample(value => results.push(value));
        client._profile = { active: "quiet", choices: ["quiet", "balanced"] };
        pending[4]({ "/sys/firmware/acpi/platform_profile": "balanced" });
        Harness.equal(results[5], false, "a sample cannot overwrite newer profile topology");

        client.refresh(value => results.push(value));
        client.destroy();
        pending[5]({
            "/sys/firmware/acpi/platform_profile": "quiet",
            "/sys/firmware/acpi/platform_profile_choices": "quiet balanced",
        });
        Harness.equal(results[6], false, "a topology reply after teardown is rejected");
        client.refresh(value => results.push(value));
        Harness.equal(results[7], false, "new refreshes after teardown are rejected");
    } finally {
        IO.readStringsAsync = real;
    }
};
