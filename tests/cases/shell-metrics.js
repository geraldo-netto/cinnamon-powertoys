/* What the shell says the menu has room for, and every fallback under it. */

const Harness = imports.harness;

const ShellMetrics = Harness.requireXlet("./lib/shell-metrics.js");

const ACTOR = { name: "applet" };

function fullShell() {
    return {
        layout: {
            findMonitorForActor: actor => {
                Harness.equal(actor, ACTOR, "the applet's own actor picks the monitor");
                return { index: 1, width: 1920 };
            },
            getWorkAreaForMonitor: index => ({ width: 1600 + index }),
            primaryMonitor: { index: 0, width: 1024 },
        },
        actor: ACTOR,
        global: { ui_scale: 2, stage: {} },
        st: { ThemeContext: { get_for_stage: () => ({ scale_factor: 3 }) } },
        gio: {
            SettingsSchemaSource: { get_default: () => ({ lookup: () => ({}) }) },
            Settings: function () { this.get_double = () => 1.25; },
        },
    };
}

var cases = {};

cases["the constraints come from the work area of the applet's own monitor"] = function () {
    Harness.deepEqual(ShellMetrics.menuConstraints(fullShell()), {
        availableWidth: 1601,
        scaleFactor: 2,
        textScale: 1.25,
    }, "each measurement is taken from the shell that answers");
};

cases["a shell without findMonitorForActor falls back to the primary monitor"] = function () {
    let shell = fullShell();
    delete shell.layout.findMonitorForActor;
    Harness.equal(ShellMetrics.menuConstraints(shell).availableWidth, 1600,
                  "the primary monitor's work area is used instead");
};

cases["a shell without getWorkAreaForMonitor falls back to the monitor width"] = function () {
    let shell = fullShell();
    delete shell.layout.getWorkAreaForMonitor;
    Harness.equal(ShellMetrics.menuConstraints(shell).availableWidth, 1920,
                  "the whole monitor is the last width available");
};

cases["a work area with no width falls back to the monitor width"] = function () {
    let shell = fullShell();
    shell.layout.getWorkAreaForMonitor = () => ({ width: 0 });
    Harness.equal(ShellMetrics.menuConstraints(shell).availableWidth, 1920,
                  "an empty answer is not a width");
};

cases["a layout manager that throws leaves the width unknown"] = function () {
    let shell = fullShell();
    shell.layout.findMonitorForActor = () => { throw new Error("no such interface"); };
    Harness.equal(ShellMetrics.menuConstraints(shell).availableWidth, 0,
                  "an unanswerable shell reports no width rather than failing");
    Harness.equal(ShellMetrics.menuConstraints({}).availableWidth, 0,
                  "and so does no layout manager at all");
};

cases["a shell with no ui_scale asks the stage's theme context"] = function () {
    let shell = fullShell();
    delete shell.global.ui_scale;
    Harness.equal(ShellMetrics.menuConstraints(shell).scaleFactor, 3,
                  "the theme context is the second source of the multiplier");

    shell.st.ThemeContext.get_for_stage = () => ({ scale_factor: 0 });
    Harness.equal(ShellMetrics.menuConstraints(shell).scaleFactor, 1,
                  "an unscaled desktop is one, not zero");

    shell.st.ThemeContext.get_for_stage = () => { throw new Error("no stage"); };
    Harness.equal(ShellMetrics.menuConstraints(shell).scaleFactor, 1,
                  "a stage St will not answer for is one too");

    shell.global = null;
    Harness.equal(ShellMetrics.menuConstraints(shell).scaleFactor, 1,
                  "and so is a shell with no global at all");
};

cases["a desktop with no interface schema is not magnifying its type"] = function () {
    let shell = fullShell();
    shell.gio.SettingsSchemaSource.get_default = () => ({ lookup: () => null });
    Harness.equal(ShellMetrics.menuConstraints(shell).textScale, 1,
                  "an absent schema is never read");

    shell = fullShell();
    shell.gio.Settings = function () { this.get_double = () => 0; };
    Harness.equal(ShellMetrics.menuConstraints(shell).textScale, 1,
                  "an unset scaling factor is one, not zero");

    shell = fullShell();
    shell.gio.SettingsSchemaSource.get_default = () => { throw new Error("no source"); };
    Harness.equal(ShellMetrics.menuConstraints(shell).textScale, 1,
                  "a settings backend that throws leaves type unmagnified");
};

cases["a schema source that will not answer is still read"] = function () {
    let shell = fullShell();
    shell.gio.SettingsSchemaSource.get_default = () => null;
    Harness.equal(ShellMetrics.menuConstraints(shell).textScale, 1.25,
                  "an unavailable source does not veto the settings read");
};
