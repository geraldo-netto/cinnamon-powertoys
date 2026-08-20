/*
 * The libraries load, and offer what the applet reaches for.
 *
 * This is the case that earns the harness: it loads each module exactly as
 * Cinnamon does and checks the names applet.js uses are all there. A rename
 * that a parse check cannot see - the file is still valid JavaScript - shows
 * up here as a missing export.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;
const Loader = imports.loader;
const Translate = Harness.requireXlet("./lib/gettext.js");
const ProfileView = Harness.requireXlet("./lib/profile-view.js");
const ProfileSelection = Harness.requireXlet("./lib/profile-selection.js");

/*
 * The profile writer the isolated applet methods ask, rather than the fields
 * they used to carry. The real one, because ownership is exactly what these
 * cases move under a reply in flight; what a move means on its own is
 * tests/cases/profile-selection.js.
 */
function selectionOver(daemon, platform, onForget) {
    let selection = new ProfileSelection.ProfileSelection(
        daemon || { available: false }, platform || { available: false },
        onForget || function () {});
    selection.choose();
    return selection;
}

/* The file tools/loader.js claims to copy. Absent on anything that is not a
 * Cinnamon desktop, which includes the runner. */
const FILE_UTILS = "/usr/share/cinnamon/js/misc/fileUtils.js";

var cases = {};

/*
 * Every library, read from the directory rather than listed.
 *
 * This was a hand-kept list, and it had drifted by four: lib/backoff.js,
 * lib/naming.js, lib/scroll-gatherer.js and lib/shell-metrics.js were absent
 * from it, which quietly excused all four from the three gates below - loading
 * at all, exporting every name their callers reach for, and staying off the
 * shell. The harness reads the directory for exactly this reason, and one of
 * the cases here says so about its own list of names.
 */
const MODULES = Harness.libraryModules().map(name => name.slice(0, -3));

for (let name of MODULES) {
    cases["lib/" + name + ".js loads"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        Harness.ok(module, name + " returned nothing");
    };
}

/*
 * Every daemon this applet talks to is watched through lib/bus.js.
 *
 * What used to be here was a count: four modules, a regular expression for a
 * forwarded cancellable, and the number of matches each was expected to have.
 * The number was the trouble. It said nothing a reader could check, it went
 * red when a forwarding was spelled differently and stayed green when one was
 * spelled the same and did the wrong thing, and it had to be edited by hand
 * every time a caller was added - which is a list of what the code does,
 * maintained beside the code that does it.
 *
 * The property it was reaching for is that a module talking to a daemon uses
 * the one port rather than writing its own, because the port is where the
 * cancellable, the bus choice and the watcher flags were unified. That needs
 * no counting: either a library names the bus functions itself or it does not.
 *
 * That each module then cancels the work it owns is a behaviour, and is held
 * as one, in the case file for that module - "owner loss cancels every pending
 * UPower proxy", "the obsolete bus work is stopped" in backlight, "BlueZ retry
 * is cancelled on owner loss and teardown", and the profiles operations.
 */
cases["no library watches a bus name except through the one port"] = function () {
    let bus = Harness.readFile(Harness.xletDir() + "/lib/bus.js");
    Harness.ok(bus.indexOf("options.cancellable || null") >= 0,
               "the one proxy builder forwards the cancellable it was given");

    let offenders = [];
    let checked = 0;
    for (let name of MODULES) {
        if (name === "bus")
            continue;
        let source = Harness.readFile(Harness.xletDir() + "/lib/" + name + ".js")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/^\s*\/\/.*$/gm, " ");
        checked++;
        for (let own of ["bus_watch_name", "bus_unwatch_name"]) {
            if (source.indexOf(own) >= 0)
                offenders.push("lib/" + name + ".js calls " + own + " itself");
        }
    }
    Harness.deepEqual(offenders, [], "the port is the only caller of the bus watcher");
    Harness.ok(checked > 20, "only " + checked + " libraries checked, which is too few");
};

/*
 * Every name any source file reaches for on a library, found by reading the
 * sources rather than by keeping a list.
 *
 * A list was kept here, and it drifted exactly where the newest code was:
 * three names the applet had started using were absent, one it had stopped
 * using was still there, and what one library used from another was outside
 * its scope entirely. A list of what the code does, maintained by hand
 * alongside the code, is a second place to forget.
 *
 * So the requires are read out of each file, and every `Alias.symbol` on one
 * of them has to resolve. A rename that a parse check cannot see - the file
 * is still valid JavaScript - fails here, whichever file did the renaming and
 * whichever did the using.
 */
function sourceFiles() {
    let files = [Harness.xletDir() + "/applet.js"];
    for (let name of Harness.shellModules())
        files.push(Harness.xletDir() + "/ui/" + name);
    for (let name of MODULES)
        files.push(Harness.xletDir() + "/lib/" + name + ".js");
    return files;
}

/* `const Sensors = require("./lib/sensors.js")` - the alias, and the module
 * path it stands for. Both directories, because a widget module is required
 * exactly the same way and a rename there is exactly as invisible. */
function requiresIn(source) {
    let aliases = {};
    let pattern = /(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\("\.\/((?:lib|ui)\/[\w-]+\.js)"\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null)
        aliases[match[1]] = match[2];
    return aliases;
}

/*
 * What a module offers, without running it.
 *
 * The modules under ui/ build Cinnamon widgets and cannot be loaded here, so
 * asking them what they export is not an option - but the loader does not ask
 * either. It appends one assignment per top level declaration, by the regexes
 * in tools/loader.js, and that is a thing that can be read off the source. So
 * these are checked the way the shell will resolve them rather than being left
 * out of the check for being unloadable.
 */
function staticExports(path) {
    let body = Loader.PREAMBLE + Harness.readFile(path) + ";";
    let names = {};
    let pattern = /exports\.([A-Za-z_$][\w$]*) =/g;
    let match;
    let assignments = Loader.exportAssignments(body);
    while ((match = pattern.exec(assignments)) !== null)
        names[match[1]] = true;
    return names;
}

function usedNames(source, alias) {
    let names = {};
    let pattern = new RegExp("\\b" + alias + "\\.([A-Za-z_$][\\w$]*)", "g");
    let match;
    while ((match = pattern.exec(source)) !== null)
        names[match[1]] = true;
    return Object.keys(names).sort();
}

cases["every name a source reaches for on a library is exported"] = function () {
    let missing = [];
    let checked = 0;

    for (let file of sourceFiles()) {
        let source = Harness.readFile(file);
        let aliases = requiresIn(source);
        for (let alias in aliases) {
            let target = aliases[alias];
            /* Loaded where it can be, read where it cannot. */
            let offered = target.indexOf("ui/") === 0
                ? staticExports(Harness.xletDir() + "/" + target)
                : Harness.requireXlet("./" + target);
            for (let symbol of usedNames(source, alias)) {
                checked++;
                if (offered[symbol] === undefined || offered[symbol] === null)
                    missing.push(file.replace(Harness.xletDir() + "/", "") +
                                 " uses " + target + "." + symbol);
            }
        }
    }

    Harness.deepEqual(missing, [], "named and not exported");
    /* If this ever reads zero the regexes have stopped matching and the case
     * is passing by finding nothing at all. */
    Harness.ok(checked > 60, "only " + checked + " names checked, which is too few to be right");
};

/*
 * The one thing in this repository that is a copy of somebody else's file.
 *
 * tools/loader.js exists so the parse check and the harness agree with what
 * Cinnamon actually evaluates, and a copy is a thing that drifts: the list had
 * been tidied into lower case and grown a "cationative" that is in no version
 * of the original. Nothing failed for it, which is the trouble - a difference
 * here shows up as a construct that passes every check and behaves differently
 * in the shell.
 *
 * Skipped where there is no Cinnamon to read, which is the runner. That means
 * this is a check somebody's desktop makes and CI cannot, so it is named in
 * the skip list rather than passing quietly.
 */
cases["the loader emulation's import names are Cinnamon's own"] = function () {
    if (!GLib.file_test(FILE_UTILS, GLib.FileTest.EXISTS))
        Harness.skip("no Cinnamon here to copy from");

    let source = Harness.readFile(FILE_UTILS);
    let match = /var importNames = \[([^\]]*)\]/.exec(source);
    Harness.ok(match, "importNames has moved in " + FILE_UTILS);

    let theirs = match[1].split(",")
        .map(entry => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(entry => entry !== "");
    Harness.deepEqual(Loader.IMPORT_NAMES, theirs,
                      "copy it verbatim, capitals and all - see the note on the list");
};

/*
 * Where a file gets its translator from.
 *
 * lib/sensors.js took `_` off lib/format.js, which works only because the
 * loader re-exports every top level declaration - so format.js was handing on a
 * `const` it never meant to publish, and sensors.js depended on it for a reason
 * that has nothing to do with formatting. The one file that owns the text
 * domain is lib/gettext.js, and asking anything else for it is asking a file
 * that happens to have already asked.
 */
cases["a file that translates asks lib/gettext.js for the translator"] = function () {
    let wrong = [];
    let checked = 0;

    for (let file of sourceFiles()) {
        let source = Harness.readFile(file);
        let match = /(?:const|var|let)\s+_\s*=\s*([A-Za-z_$][\w$]*)\._\s*;/.exec(source);
        if (!match)
            continue;
        checked++;
        if (requiresIn(source)[match[1]] !== "lib/gettext.js")
            wrong.push(file.replace(Harness.xletDir() + "/", "") + " takes _ from " + match[1]);
    }

    Harness.deepEqual(wrong, [], "second hand translators");
    Harness.ok(checked > 4, "only " + checked + " files checked, which is too few to be right");
};

cases["the libraries load without a shell"] = function () {
    /* lib/log.js exists so that nothing in lib/ touches Cinnamon's globals at
     * load time. If something starts to, this is where it shows. */
    Harness.equal(typeof globalThis.global, "undefined",
                  "a library defined a shell global just by being loaded");
};

cases["partial applet construction owns its rollback"] = function () {
    let source = Harness.shellSource();
    let start = source.indexOf("constructor(metadata, orientation");
    let constructor = source.slice(start, source.indexOf("\n    _initialize(metadata", start));
    Harness.ok(constructor.indexOf("try {") >= 0, "initialization has a guarded acquisition stage");
    Harness.ok(constructor.indexOf("this._teardown()") >= 0,
               "a constructor that cannot return releases its partial state");
    Harness.ok(source.indexOf("on_applet_removed_from_panel() {\n        this._teardown();") >= 0,
               "normal removal uses the same teardown path");
};

cases["a late collection stops when its applet is destroyed"] = function () {
    /* applet.js needs Cinnamon's UI modules and cannot be loaded by the
     * shell-free runner. Exercise its collection method with only the two
     * asynchronous backend contracts it uses. */
    let source = Harness.shellSource();
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the collection method can be isolated");

    let logged = [];
    let collect = Function("Collection", "Log",
        "return function (onDone, sampleCpu) {" + match[1] + "\n};")(
        Harness.requireXlet("./lib/collection.js"),
        { error: message => logged.push(message) });
    let sensorDone = null;
    let cpuDone = null;
    let assembled = 0;
    let answers = [];
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        _sensorFilter: () => function () { return true; },
        _sensors: {
            readAsync: (wanted, onDone) => { sensorDone = onDone; },
        },
        _cpu: {
            sample: onDone => { cpuDone = onDone; },
        },
        _assemble: readings => {
            assembled++;
            return readings;
        },
    };
    applet._profileSelection = selectionOver({ available: true });

    collect.call(applet, answer => answers.push(answer));
    sensorDone({ temperatures: [] });
    applet._destroyed = true;
    cpuDone(false);

    Harness.equal(assembled, 0, "destroyed backends are not read while assembling");
    Harness.deepEqual(answers, [null], "the abandoned collection still settles exactly once");
    Harness.deepEqual(logged, [], "ordinary teardown is not reported as a collection error");
};

cases["collection waits for asynchronous charge and firmware samples"] = function () {
    let source = Harness.shellSource();
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the collection method can be isolated");
    let collect = Function("Collection", "Log",
        "return function (onDone, sampleCpu) {" + match[1] + "\n};")(
        Harness.requireXlet("./lib/collection.js"),
        { error: message => { throw new Error(message); } });
    let pending = {};
    let answers = [];
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        menu: { isOpen: true },
        _sensorFilter: () => function () { return true; },
        _sensors: { readAsync: (wanted, done) => { pending.sensors = done; } },
        _cpu: { sample: done => { pending.cpu = done; } },
        _chargeControl: { sample: done => { pending.charge = done; } },
        _assemble: (readings, profile) => ({ readings: readings, profile: profile }),
    };
    let writer = {
        available: true,
        sample: done => { pending.profile = done; },
        snapshot: () => ({ active: "balanced" }),
    };
    applet._profileSelection = selectionOver(writer);

    collect.call(applet, answer => answers.push(answer));
    pending.sensors({ temperatures: [] });
    pending.cpu(true);
    pending.charge(true);
    Harness.deepEqual(answers, [], "three of four backend answers are not a snapshot");
    pending.profile(true);
    Harness.equal(answers.length, 1, "the complete snapshot answers once");
    Harness.deepEqual(answers[0].readings, { temperatures: [] }, "with the sensor reading");
    Harness.equal(answers[0].profile.source, writer, "and the sampled profile writer");
    Harness.equal(answers[0].profile.generation, applet._profileSelection.generation,
                  "from the same backend generation");
};

cases["hidden collections skip live CPU sampling"] = function () {
    let source = Harness.shellSource();
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the collection method can be isolated");
    let collect = Function("Collection", "Log",
        "return function (onDone, sampleCpu) {" + match[1] + "\n};")(
        Harness.requireXlet("./lib/collection.js"),
        { error: message => { throw new Error(message); } });
    let sampled = 0;
    let answer = null;
    let backend = { available: true, snapshot: () => ({ active: "balanced" }) };
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        _profileSelection: selectionOver(backend),
        _sensorFilter: () => function () { return true; },
        _sensors: { readAsync: (wanted, done) => done({ temperatures: [] }) },
        _cpu: { sample: () => sampled++ },
        _assemble: readings => readings,
    };

    collect.call(applet, value => { answer = value; }, false);
    Harness.equal(sampled, 0, "no moving CPU node is requested");
    Harness.deepEqual(answer, { temperatures: [] }, "the cached CPU snapshot can assemble");
};

cases["CPU sampling follows visible consumers"] = function () {
    let source = Harness.shellSource();
    let match = /    _cpuSampleWanted\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(match, "the CPU visibility policy can be isolated");
    let wanted = Function("return function () {" + match[1] + "\n};")();
    let applet = {
        menu: { isOpen: false },
        showCpu: true,
        showSensors: true,
        _panel: { tooltipNeedsFreshData: false },
    };

    Harness.equal(wanted.call(applet), false, "a hidden menu and tooltip need no sample");
    applet.menu.isOpen = true;
    Harness.equal(wanted.call(applet), true, "an open CPU menu needs current values");
    applet.showCpu = false;
    applet.showSensors = false;
    Harness.equal(wanted.call(applet), false, "a menu with no CPU reading does not");
    applet.menu.isOpen = false;
    applet._panel.tooltipNeedsFreshData = true;
    Harness.equal(wanted.call(applet), true, "a visible tooltip needs current values");
};

cases["profile collections and controls reject a backend transition"] = function () {
    let source = Harness.shellSource();
    let collectMatch = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n/.exec(source);
    let contextMatch = /    _profileContext\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(collectMatch && contextMatch, "the profile wiring can be isolated");

    let collect = Function("Collection", "Log",
        "return function (onDone, sampleCpu) {" + collectMatch[1] + "\n};")(
        Harness.requireXlet("./lib/collection.js"),
        { error: message => { throw new Error(message); } });
    /* _profileState is one call now: the rule is lib/profile-view.js and what
     * is left in the applet is assembling the context to ask it with. That
     * assembly is what this isolates; the rule has its own cases. */
    let profileContext = Function("return function () {" + contextMatch[1] + "\n};")();
    let profileState = function () {
        return ProfileView.steppableState(this._latest, profileContext.call(this));
    };
    let pending = {};
    let forgotten = 0;
    let daemon = { available: false, sample: done => { pending.profile = done; } };
    let firmware = { available: true };
    let selection = new ProfileSelection.ProfileSelection(
        daemon, firmware, () => forgotten++);
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        _profiles: daemon,
        _platformProfiles: firmware,
        _profileSelection: selection,
        _pending: { forget: () => forgotten++ },
        _sensorFilter: () => function () { return true; },
        _sensors: { readAsync: (wanted, done) => { pending.sensors = done; } },
        _cpu: { sample: done => { pending.cpu = done; } },
        _assemble: () => { throw new Error("a stale profile was assembled"); },
        enablePrivilegedControls: true,
    };

    Harness.equal(selection.choose(), true, "the firmware backend is selected");
    Harness.equal(selection.backend, firmware, "firmware owns this generation");
    Harness.equal(selection.generation, 1, "the first owner has a generation");
    Harness.equal(selection.choose(), false, "an unchanged owner is not a transition");
    Harness.equal(forgotten, 1, "an unchanged choice does not discard a request");

    /* Start with a daemon so its sample can remain outstanding, then move
     * ownership to firmware before that sample answers. */
    daemon.available = true;
    Harness.equal(selection.choose(), true, "the appearing daemon takes ownership");
    let daemonGeneration = selection.generation;
    applet.menu = null;
    collect.call(applet, answer => { pending.answer = answer; });
    pending.sensors({ temperatures: [] });
    pending.cpu(true);

    daemon.available = false;
    Harness.equal(selection.choose(), true, "the vanished daemon returns ownership");
    Harness.equal(profileState.call(Object.assign(applet, {
        _latest: { profile: {
            available: true,
            list: ["balanced", "performance"],
            source: daemon,
            generation: daemonGeneration,
        } },
    })), null, "controls from the previous generation are disabled immediately");

    pending.profile(true);
    Harness.equal(pending.answer, null, "the old collection is discarded, not presented");

    let firmwareState = {
        available: true,
        list: ["low-power", "balanced", "performance"],
        source: firmware,
        generation: selection.generation,
    };
    applet._latest = { profile: firmwareState };
    applet._helper = { busy: true };
    Harness.equal(profileState.call(applet), null,
                  "a helper-backed profile is gated while another mutation is active");
    applet._helper.busy = false;
    Harness.equal(profileState.call(applet), firmwareState,
                  "the firmware profile returns when the helper is free");

    daemon.available = true;
    selection.choose();
    let daemonState = {
        available: true,
        list: ["balanced", "performance"],
        source: daemon,
        generation: selection.generation,
    };
    applet._latest = { profile: daemonState };
    applet._helper.busy = true;
    Harness.equal(profileState.call(applet), daemonState,
                  "the unprivileged daemon stays responsive while the helper is busy");
};

cases["a profile write stays with the backend that produced its control"] = function () {
    let source = Harness.shellSource();
    let match = /    _setProfile\(name, onResult\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the profile action can be isolated");
    let setProfile = Function(
        "Profiles", "return function (name, onResult) {" + match[1] + "\n};")({
        profileWriteError: outcome => outcome,
    });

    let oldDone = null;
    let writes = [];
    let daemon = {
        available: true,
        setProfile: (name, done) => {
            writes.push(name);
            oldDone = done;
            return true;
        },
    };
    let firmware = {
        available: false,
        setProfile: () => { throw new Error("wrong profile backend"); },
    };
    let selection = new ProfileSelection.ProfileSelection(daemon, firmware);
    selection.choose();
    let profile = { source: daemon, generation: selection.generation };
    let notices = [];
    let results = [];
    let updates = 0;
    let applet = {
        _profileSelection: selection,
        _profileState: () => profile,
        _shownProfile: () => "balanced",
        _latest: { profile: profile },
        _pending: {
            value: null,
            request: (name, write, report) => write(outcome => report(outcome, true)),
        },
        _notifyProfileError: (name, error) => notices.push([name, error]),
        _scheduleUpdate: () => updates++,
    };

    Harness.equal(setProfile.call(applet, "performance", error => results.push(error)), true,
                  "the write was accepted");
    Harness.deepEqual(writes, ["performance"], "the snapshot's backend received it");

    /* The daemon goes and the firmware takes over while the write is out. */
    daemon.available = false;
    firmware.available = true;
    selection.choose();
    Harness.equal(selection.backend, firmware, "the firmware owns the controls now");
    oldDone(new Error("old daemon vanished"));
    Harness.deepEqual(notices, [], "the obsolete writer cannot report against new controls");
    Harness.deepEqual(results, [], "nor report a result for the obsolete control");
    Harness.equal(updates, 2, "the optimistic and final states are both redrawn");
};

cases["profile announcements wait for matching success"] = function () {
    let source = Harness.shellSource();
    let match = /    _stepProfile\(step, wrap, announce\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the profile step can be isolated");
    let notices = [];
    let callbacks = [];
    let stepProfile = Function(
        "Profiles", "ProfileView", "_",
        "return function (step, wrap, announce) {" + match[1] + "\n};")({
        nextProfile: () => "performance",
    }, {
        announcement: name => "Power profile: " + name,
    }, text => text);
    let applet = {
        _profileState: () => ({ list: ["balanced", "performance"] }),
        _shownProfile: () => "balanced",
        _setProfile: (name, done) => {
            callbacks.push(done);
            return true;
        },
        _notifications: { notify: (title, body) => notices.push([title, body]) },
    };

    Harness.equal(stepProfile.call(applet, 1, true, true), true, "the step was accepted");
    Harness.deepEqual(notices, [], "acceptance alone announces nothing");
    callbacks.shift()(new Error("authentication cancelled"));
    Harness.deepEqual(notices, [], "a failed result announces nothing");

    stepProfile.call(applet, 1, true, true);
    Harness.deepEqual(notices, [], "the next accepted request still waits");
    callbacks.shift()(null);
    Harness.deepEqual(notices, [["Power Toys", "Power profile: performance"]],
                      "only the matching success is announced");
};

cases["presentation consumers fail independently"] = function () {
    let source = Harness.shellSource();
    /* To the first line that is a closing brace at method indentation, which
     * is the end of _present: everything inside it is indented further. The
     * anchor used to be the comment on the next method, so moving that method
     * turned this case into "the boundary cannot be isolated". */
    let match = /    _present\(data\) \{([\s\S]*?)\n    \}\n/.exec(source);
    Harness.ok(match, "the presentation boundary can be isolated");
    let logs = [];
    let present = Function("Log", "return function (data) {" + match[1] + "\n};")({
        error: message => logs.push(message),
    });
    let calls = [];
    let active = new Set();
    let failing = true;
    let consume = name => {
        calls.push(name);
        if (failing && name !== "alerts")
            throw new Error(name + " broke");
    };
    let applet = {
        _latest: null,
        _failures: {
            report: (key, message) => {
                if (active.has(key))
                    return false;
                active.add(key);
                logs.push(message);
                return true;
            },
            recover: key => active.delete(key),
        },
        _pending: { settle: () => consume("pending") },
        _panel: { update: () => consume("panel") },
        _panelOptions: () => ({}),
        _menuPresenter: {
            update: () => consume("menu"),
        },
        _menuOptions: () => ({}),
        menu: { isOpen: true },
        _alerts: { check: () => consume("alerts") },
        _alertLimits: () => ({}),
    };
    let data = { profile: { active: "balanced" } };

    present.call(applet, data);
    Harness.equal(applet._latest, data, "every consumer observes the same adopted snapshot");
    Harness.deepEqual(calls, ["pending", "panel", "menu", "alerts"],
                      "later consumers still run after independent failures");
    Harness.equal(logs.length, 3, "each failed consumer is diagnosed once");

    present.call(applet, data);
    Harness.equal(logs.length, 3, "persistent presentation failures stay quiet");
    failing = false;
    present.call(applet, data);
    failing = true;
    present.call(applet, data);
    Harness.equal(logs.length, 6, "a success rearms later presentation failures");
};

cases["slow rediscovery includes CPU topology"] = function () {
    let source = Harness.shellSource();
    let rediscover = /    _rediscover\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(rediscover, "the rediscovery method can be isolated");
    Harness.ok(rediscover[1].indexOf("this._cpu.refresh()") >= 0,
               "the periodic hardware sweep refreshes CPU policies and drivers");

    let opened = /    _onMenuOpened\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(opened, "the menu-open method can be isolated");
    Harness.equal(opened[1].indexOf("this._cpu.refresh()"), -1,
                  "menu opening reuses the shared rediscovery path");
    Harness.ok(opened[1].indexOf('["screen", "keyboard"]') >= 0,
               "only the signal-backed kernel controls are considered for a retry");
    Harness.ok(opened[1].indexOf("!control.available") >= 0,
               "an available D-Bus backlight keeps its cached signal-driven value");
    Harness.equal(opened[1].indexOf("for (let name in this._backlights)"), -1,
                  "external monitors stay on their separate DDC probe lifecycle");
};

cases["a monitor overflow note cannot create an empty brightness group"] = function () {
    let source = Harness.shellSource();
    let sync = /    _syncMonitors\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(sync, "the monitor presentation method can be isolated");
    Harness.ok(
        /if \(entries\.length > 0 && this\._monitors\.hidden > 0\)/.test(sync[1]),
        "overflow is shown only beside at least one available monitor slider");
};

/*
 * The line between the two directories.
 *
 * lib/ is loaded, measured and mutated by this suite; ui/ cannot be loaded
 * into this process at all, and what tests/cases/shell-load.js proves about it
 * elsewhere is that it loads. So a decision that moves from lib/ into ui/
 * leaves almost every gate here without noticing, which is exactly the
 * direction this repository has drifted before. Two rules keep the boundary readable: nothing in lib/ may touch
 * Cinnamon's UI modules or its widget toolkit, and nothing in lib/ may require
 * a module out of ui/.
 */
cases["nothing in lib reaches for the shell"] = function () {
    let offenders = [];
    let checked = 0;
    for (let name of MODULES) {
        let file = "lib/" + name + ".js";
        /* Code only: these files explain the boundary in their comments, and
         * naming a module in prose is not importing it. */
        let source = Harness.readFile(Harness.xletDir() + "/" + file)
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/^\s*\/\/.*$/gm, " ");
        checked++;
        for (let forbidden of ["imports.ui.", "imports.gi.St", "imports.gi.Clutter",
                               "imports.gi.Atk", "imports.gi.Pango", "imports.gi.Gtk"]) {
            if (source.indexOf(forbidden) >= 0)
                offenders.push(file + " uses " + forbidden);
        }
        if (/require\("\.\/ui\//.test(source))
            offenders.push(file + " requires a widget module");
    }
    Harness.deepEqual(offenders, [], "a library that needs the shell is not a library");
    Harness.ok(checked > 20, "only " + checked + " libraries checked, which is too few");
};

cases["every widget module is one of the shell sources"] = function () {
    /* The cases that read shell code read applet.js and everything under ui/.
     * A module added to ui/ and left out of that list would be code nothing
     * here looks at, not even as text. */
    let names = Harness.shellModules();
    Harness.ok(names.length > 0, "there are widget modules to check");
    let source = Harness.shellSource();
    for (let name of names) {
        let text = Harness.readFile(Harness.xletDir() + "/ui/" + name);
        Harness.ok(source.indexOf(text) >= 0, "ui/" + name + " is part of the shell source");
    }
};

/*
 * The emulation's own two answers.
 *
 * `compile` is what the parse check hands a file to, and `giNames` is what
 * decides whether a top level `const Gio` is an export or an import
 * namespace - and both were reached only from processes of their own, so the
 * suite executed neither. The repository lookup has three outcomes and one of
 * them is an interpreter that will not answer at all, which is why the
 * fallback list exists.
 */
cases["the compiler is the one the shell would use"] = function () {
    let body = Loader.moduleBody("var value = 7;");
    let built = Loader.compile(body);
    Harness.equal(typeof built, "function", "a body compiles to a function");
    Harness.deepEqual(built.length, Loader.PARAMETERS.length,
                      "taking the parameters Cinnamon binds");
    let module = { exports: {} };
    Harness.equal(built(null, module.exports, module).value, 7,
                  "and running it exports what the file declared");
    let threw = false;
    try {
        Loader.compile("function main( {");
    } catch (error) {
        threw = true;
    }
    Harness.ok(threw, "what the engine cannot parse throws rather than compiles");
};

cases["the GI namespaces come from the repository, however it answers"] = function () {
    let modern = Loader.giNames({
        dup_default: () => ({ get_loaded_namespaces: () => ["Gio", "St"] }),
        get_default: () => Harness.fail("dup_default is preferred where it exists"),
    });
    Harness.deepEqual(modern, ["Gio", "St"], "the current call is used where there is one");

    let older = Loader.giNames({
        get_default: () => ({ get_loaded_namespaces: () => ["GLib"] }),
    });
    Harness.deepEqual(older, ["GLib"], "and the older one where there is not");

    let refused = Loader.giNames({ get_default: () => { throw new Error("no repository"); } });
    Harness.ok(refused.indexOf("Gio") >= 0 && refused.indexOf("St") >= 0,
               "an interpreter that will not answer gets the written out list");

    /* Not a guess: whatever the fallback says, the loader must not re-export
     * a name that is one of these. */
    let assignments = Loader.exportAssignments(
        Loader.PREAMBLE + "const Gio = imports.gi.Gio;\nconst Value = 1;\n", refused);
    Harness.ok(assignments.indexOf("exports.Value") >= 0, "a declaration is exported");
    Harness.ok(assignments.indexOf("exports.Gio") < 0,
               "and an import namespace is not, on the fallback list as on the real one");
};

cases["bytes become text on either interpreter"] = function () {
    let bytes = new TextEncoder().encode("a sentence\n");
    Harness.equal(Loader.decode(bytes), "a sentence\n", "the current decoder answers");
    Harness.equal(Loader.decode(bytes, null), "a sentence\n",
                  "and so does the one Mozilla JavaScript 78 has instead");
    Harness.equal(Loader.decode(bytes, { decode: () => "substituted" }), "substituted",
                  "whatever the interpreter offers is what is used");
};

/*
 * Every require names a file this applet ships.
 *
 * The case above reads requires through a pattern that only matches
 * `require("./lib/x.js")` and `require("./ui/x.js")`, which means a require of
 * anything else is not checked - it is not even seen. `require("fs")` is what
 * that looks like when it happens: valid JavaScript, a name the scope check
 * resolves because `require` is one of the six the loader binds, and a module
 * that throws the moment Cinnamon evaluates it on somebody's desktop. A
 * mistyped path, or a path into a directory that was renamed, reads exactly
 * the same.
 *
 * So every require in the payload is resolved the way Cinnamon resolves one -
 * relative to the xlet directory, never to the file doing the requiring - and
 * the file it names has to be there.
 */
cases["every require names a file the applet ships"] = function () {
    const Scan = imports.scan;
    const Sources = imports.sources;
    let broken = [];
    let checked = 0;
    for (let relative of Sources.jsFiles(Harness.xletDir(), "")) {
        let source = Harness.readFile(Harness.xletDir() + "/" + relative);
        let written = Scan.literals(source);
        let pattern = /\brequire\(\s*"([^"]*)"\s*\)/g;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            let target = match[1];
            if (written.indexOf(target) < 0)
                continue;
            checked++;
            if (target.indexOf("./") !== 0) {
                broken.push(relative + " requires " + target +
                            ", which is not a path into this applet");
                continue;
            }
            let path = Harness.xletDir() + "/" + target.replace(/\.\//g, "");
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                broken.push(relative + " requires " + target + ", which is not there");
        }
    }
    Harness.deepEqual(broken, [], "a require that names nothing is a module that will not load");
    Harness.ok(checked > 30, "only " + checked + " requires checked, which is too few");
};
