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

/* The applet's one-line ownership check, for an isolated method that calls it.
 * What the check itself means is tests/cases/profile-view.js. */
function stillOwned(applet) {
    return (backend, generation) => ProfileView.sameOwner(
        { source: backend, generation: generation },
        applet._profileBackend, applet._profileBackendGeneration);
}

/* The file tools/loader.js claims to copy. Absent on anything that is not a
 * Cinnamon desktop, which includes the runner. */
const FILE_UTILS = "/usr/share/cinnamon/js/misc/fileUtils.js";

var cases = {};

const MODULES = ["io", "log", "gettext", "backends", "format", "device", "hardware", "sensors", "cpu",
                 "power-supply", "privileged", "owner-watch", "upower", "profiles", "backlight", "ddc",
                 "bluez", "alerts", "reading", "sensor-rows", "panel-text", "pending-profile",
                 "keyed-list", "cinnamon-panel", "notifications", "panel-presenter",
                 "profile-view", "menu-layout"];

for (let name of MODULES) {
    cases["lib/" + name + ".js loads"] = function () {
        let module = Harness.requireXlet("./lib/" + name + ".js");
        Harness.ok(module, name + " returned nothing");
    };
}

cases["runtime D-Bus constructors forward lifecycle cancellables"] = function () {
    let expected = { bluez: 1, backlight: 1, profiles: 1, upower: 2 };
    for (let name in expected) {
        let source = Harness.readFile(Harness.xletDir() + "/lib/" + name + ".js");
        let forwards = source.match(/cancellable \|\| null/g) || [];
        Harness.equal(forwards.length, expected[name],
                      name + " forwards every owned cancellable to Gio");
    }
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
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* The sensor readings/.exec(source);
    Harness.ok(match, "the collection method can be isolated");

    let logged = [];
    let collect = Function("Log", "return function (onDone, sampleCpu) {" +
        match[1] + "\n};")({
        error: message => logged.push(message),
    });
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

    applet._stillOwned = stillOwned(applet);
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
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* The sensor readings/.exec(source);
    Harness.ok(match, "the collection method can be isolated");
    let collect = Function("Log", "return function (onDone, sampleCpu) {" +
        match[1] + "\n};")({
        error: message => { throw new Error(message); },
    });
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
        _profileBackend: {
            sample: done => { pending.profile = done; },
            snapshot: () => ({ active: "balanced" }),
        },
        _profileBackendGeneration: 4,
        _collectProfile: (backend, generation) => ({ backend: backend, generation: generation }),
        _assemble: (readings, profile) => ({ readings: readings, profile: profile }),
    };

    applet._stillOwned = stillOwned(applet);
    collect.call(applet, answer => answers.push(answer));
    pending.sensors({ temperatures: [] });
    pending.cpu(true);
    pending.charge(true);
    Harness.deepEqual(answers, [], "three of four backend answers are not a snapshot");
    pending.profile(true);
    Harness.equal(answers.length, 1, "the complete snapshot answers once");
    Harness.deepEqual(answers[0].readings, { temperatures: [] }, "with the sensor reading");
    Harness.equal(answers[0].profile.backend, applet._profileBackend,
                  "and the sampled profile writer");
    Harness.equal(answers[0].profile.generation, 4, "from the same backend generation");
};

cases["hidden collections skip live CPU sampling"] = function () {
    let source = Harness.shellSource();
    let match = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* The sensor readings/.exec(source);
    Harness.ok(match, "the collection method can be isolated");
    let collect = Function("Log", "return function (onDone, sampleCpu) {" +
        match[1] + "\n};")({ error: message => { throw new Error(message); } });
    let sampled = 0;
    let answer = null;
    let backend = { snapshot: () => ({ active: "balanced" }) };
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        _profileBackend: backend,
        _profileBackendGeneration: 1,
        _sensorFilter: () => function () { return true; },
        _sensors: { readAsync: (wanted, done) => done({ temperatures: [] }) },
        _cpu: { sample: () => sampled++ },
        _collectProfile: () => ({}),
        _assemble: readings => readings,
    };

    applet._stillOwned = stillOwned(applet);
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
    let collectMatch = /    _collect\(onDone, sampleCpu\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* The sensor readings/.exec(source);
    let chooseMatch = /    _chooseProfileBackend\(\) \{([\s\S]*?)\n    \}\n\n    \/\* One look/.exec(source);
    let contextMatch = /    _profileContext\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(collectMatch && chooseMatch && contextMatch, "the profile wiring can be isolated");

    let collect = Function("Log", "return function (onDone, sampleCpu) {" +
        collectMatch[1] + "\n};")({
        error: message => { throw new Error(message); },
    });
    let choose = Function("return function () {" + chooseMatch[1] + "\n};")();
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
    let applet = {
        _destroyed: false,
        _failures: new (Harness.requireXlet("./lib/log.js").FailureLog)(),
        _profiles: daemon,
        _platformProfiles: firmware,
        _profileBackend: null,
        _profileBackendAvailable: false,
        _profileBackendGeneration: 0,
        _pending: { forget: () => forgotten++ },
        _sensorFilter: () => function () { return true; },
        _sensors: { readAsync: (wanted, done) => { pending.sensors = done; } },
        _cpu: { sample: done => { pending.cpu = done; } },
        _collectProfile: () => { throw new Error("a stale profile was collected"); },
        _assemble: () => { throw new Error("a stale profile was assembled"); },
        enablePrivilegedControls: true,
    };

    Harness.equal(choose.call(applet), true, "the firmware backend is selected");
    Harness.equal(applet._profileBackend, firmware, "firmware owns this generation");
    Harness.equal(applet._profileBackendGeneration, 1, "the first owner has a generation");
    Harness.equal(choose.call(applet), false, "an unchanged owner is not a transition");
    Harness.equal(forgotten, 1, "an unchanged choice does not discard a request");

    /* Start with a daemon so its sample can remain outstanding, then move
     * ownership to firmware before that sample answers. */
    daemon.available = true;
    Harness.equal(choose.call(applet), true, "the appearing daemon takes ownership");
    let daemonGeneration = applet._profileBackendGeneration;
    applet.menu = null;
    applet._stillOwned = stillOwned(applet);
    collect.call(applet, answer => { pending.answer = answer; });
    pending.sensors({ temperatures: [] });
    pending.cpu(true);

    daemon.available = false;
    Harness.equal(choose.call(applet), true, "the vanished daemon returns ownership");
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
        generation: applet._profileBackendGeneration,
    };
    applet._latest = { profile: firmwareState };
    applet._helper = { busy: true };
    Harness.equal(profileState.call(applet), null,
                  "a helper-backed profile is gated while another mutation is active");
    applet._helper.busy = false;
    Harness.equal(profileState.call(applet), firmwareState,
                  "the firmware profile returns when the helper is free");

    daemon.available = true;
    choose.call(applet);
    let daemonState = {
        available: true,
        list: ["balanced", "performance"],
        source: daemon,
        generation: applet._profileBackendGeneration,
    };
    applet._latest = { profile: daemonState };
    applet._helper.busy = true;
    Harness.equal(profileState.call(applet), daemonState,
                  "the unprivileged daemon stays responsive while the helper is busy");
};

cases["a profile write stays with the backend that produced its control"] = function () {
    let source = Harness.shellSource();
    let match = /    _setProfile\(name, onResult\) \{([\s\S]*?)\n    \}\n\n    \/\*\n     \* A password dialog/.exec(source);
    Harness.ok(match, "the profile action can be isolated");
    let setProfile = Function(
        "Reading", "Profiles", "return function (name, onResult) {" + match[1] + "\n};")({
        shownProfile: () => "balanced",
    }, {
        profileWriteError: outcome => outcome,
    });

    let oldDone = null;
    let writes = [];
    let daemon = {
        setProfile: (name, done) => {
            writes.push(name);
            oldDone = done;
            return true;
        },
    };
    let firmware = { setProfile: () => { throw new Error("wrong profile backend"); } };
    let profile = { source: daemon, generation: 7 };
    let notices = [];
    let results = [];
    let updates = 0;
    let applet = {
        _profileBackend: daemon,
        _profileBackendGeneration: 7,
        _profileState: () => profile,
        _latest: { profile: profile },
        _pending: {
            value: null,
            request: (name, write, report) => write(outcome => report(outcome, true)),
        },
        _notifyProfileError: (name, error) => notices.push([name, error]),
        _scheduleUpdate: () => updates++,
    };
    applet._stillOwned = stillOwned(applet);

    Harness.equal(setProfile.call(applet, "performance", error => results.push(error)), true,
                  "the write was accepted");
    Harness.deepEqual(writes, ["performance"], "the snapshot's backend received it");

    applet._profileBackend = firmware;
    applet._profileBackendGeneration = 8;
    oldDone(new Error("old daemon vanished"));
    Harness.deepEqual(notices, [], "the obsolete writer cannot report against new controls");
    Harness.deepEqual(results, [], "nor report a result for the obsolete control");
    Harness.equal(updates, 2, "the optimistic and final states are both redrawn");
};

cases["profile announcements wait for matching success"] = function () {
    let source = Harness.shellSource();
    let match = /    _stepProfile\(step, wrap, announce\) \{([\s\S]*?)\n    \}\n\n    _cycleProfile/.exec(source);
    Harness.ok(match, "the profile step can be isolated");
    let notices = [];
    let callbacks = [];
    let stepProfile = Function(
        "Reading", "Profiles", "Main", "_", "Format", "Translate",
        "return function (step, wrap, announce) {" + match[1] + "\n};")({
        shownProfile: () => "balanced",
    }, {
        nextProfile: () => "performance",
    }, {
        notify: (title, body) => notices.push([title, body]),
    }, text => text, {
        profileLabel: name => name,
    }, Translate);
    let applet = {
        _profileState: () => ({ list: ["balanced", "performance"] }),
        _latest: {},
        _pending: { value: null },
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
    let match = /    _present\(data\) \{([\s\S]*?)\n    \}\n\n    \/\* What the three switches/.exec(source);
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
 * here at all. So a decision that moves from lib/ into ui/ leaves the suite
 * without noticing, which is exactly the direction this repository has drifted
 * before. Two rules keep the boundary readable: nothing in lib/ may touch
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
