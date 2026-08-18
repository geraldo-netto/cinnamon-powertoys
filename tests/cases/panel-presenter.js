/*
 * The panel item.
 *
 * It puts a label, an icon and a tooltip on the panel and reads nothing back.
 * Two things here are worth pinning down. The first is the icon cache: setting
 * an icon costs a texture lookup and this runs on every poll, so an icon that
 * has not changed must not be set again - and anything that rebuilds the actor
 * underneath it must be able to say so, or the panel keeps an empty box. The
 * second is that a reading the daemon described badly still leaves a usable
 * icon on the panel.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const PanelPresenter = Harness.requireXlet("./lib/panel-presenter.js");

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;
const Level = UPowerGlib.DeviceLevel;

/* An applet as far as the panel adapter is concerned: the four calls that put
 * something on the panel, and the private icon actor it puts a Gio.Icon on. */
function shellApplet(calls) {
    return {
        actor: null,
        _applet_icon: {
            gicon: null,
            set_icon_size: () => {},
            set_style: () => {},
        },
        set_applet_label: text => calls.push(["label", text]),
        set_applet_tooltip: text => calls.push(["tooltip", text]),
        set_applet_icon_symbolic_name: name => calls.push(["symbolic", name]),
        set_applet_icon_path: path => calls.push(["path", path]),
        set_applet_icon_name: name => calls.push(["name", name]),
    };
}

function presenter(calls, onTooltip) {
    return new PanelPresenter.PanelPresenter(
        shellApplet(calls), "/icons", onTooltip || function () {});
}

function reading(parts) {
    return Object.assign({
        upowerAvailable: true,
        devices: [],
        lines: [],
        primary: null,
        onBattery: false,
        cpu: { governor: null, averageFrequency: null, maxFrequency: null },
        selectedTemperature: null,
        powers: [],
        packageWatts: null,
        systemWatts: null,
        systemWattsSource: null,
        profile: { active: null, list: [], available: false, holds: [], degraded: null },
    }, parts || {});
}

function battery(parts) {
    return Object.assign({
        path: "/battery_BAT0", kind: Kind.BATTERY, state: State.DISCHARGING,
        vendor: "", model: "BAT0", powerSupply: true, percentage: 61,
        batteryLevel: Level.NONE, timeToEmpty: 7200, timeToFull: 0,
        icon: "battery-good-symbolic",
    }, parts || {});
}

function options(parts) {
    return Object.assign({
        showBattery: true, showPower: false, showProfile: false,
        iconSource: "auto", tempUnit: "celsius", pendingProfile: null,
    }, parts || {});
}

function iconCalls(calls) {
    return calls.filter(call => call[0] !== "label" && call[0] !== "tooltip");
}

var cases = {};

cases["an update puts the label and the icon on the panel"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading({ primary: battery() }), options());

    Harness.ok(calls.some(call => call[0] === "label"), "the panel text is set");
    Harness.equal(iconCalls(calls).length, 1, "and one icon is set with it");
    panel.destroy();
};

cases["an icon that has not changed is not set again"] = function () {
    let calls = [];
    let panel = presenter(calls);
    let data = reading({ primary: battery() });
    panel.update(data, options());
    panel.update(data, options());
    panel.update(reading({ primary: battery({ percentage: 55 }) }), options());

    Harness.equal(iconCalls(calls).length, 1,
                  "three polls of the same icon cost one texture lookup");
    panel.destroy();
};

cases["a different icon is set"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading({ primary: battery() }), options());
    panel.update(reading({ primary: battery({ icon: "battery-low-symbolic" }) }), options());

    Harness.equal(iconCalls(calls).length, 2, "the changed icon reaches the panel");
    panel.destroy();
};

cases["dropping the cache makes the next update set the icon again"] = function () {
    let calls = [];
    let panel = presenter(calls);
    let data = reading({ primary: battery() });
    panel.update(data, options());
    panel.invalidateIcon();
    panel.update(data, options());

    Harness.equal(iconCalls(calls).length, 2,
                  "a rebuilt actor is filled rather than left empty");
    panel.destroy();
};

cases["malformed battery icon metadata keeps the panel fallback"] = function () {
    /* UPower publishes the icon name; a device that names something that is
     * not an icon at all must not cost the panel its icon. */
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading({ primary: battery({ icon: "not a valid icon" }) }), options());

    let icons = iconCalls(calls);
    Harness.equal(icons.length, 1, "an icon is still set");
    Harness.ok(icons[0][0] !== "path", "and it is not a path into the applet directory");
    panel.destroy();
};

cases["a profile icon is loaded from the applet's own directory"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(
        reading({ profile: { active: "performance", list: ["performance"],
                             available: true, holds: [], degraded: null } }),
        options({ iconSource: "profile", showProfile: true }));

    let icons = iconCalls(calls);
    Harness.equal(icons.length, 1, "one icon is set");
    Harness.equal(icons[0][0], "path", "by path, because these three carry colour");
    Harness.ok(icons[0][1].indexOf("/icons/") === 0,
               "from the directory the presenter was given: " + icons[0][1]);
};

cases["with nothing else to show the applet's own icon is used"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading(), options({ showBattery: false }));

    Harness.deepEqual(iconCalls(calls), [["symbolic", "powertoys"]],
                      "the default symbolic icon, once");
    panel.destroy();
};

cases["the tooltip is written when the shell cannot say whether it is up"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading({ primary: battery() }), options());
    Harness.ok(calls.some(call => call[0] === "tooltip"),
               "a shell with no tooltip lifecycle is kept fresh regardless");
    Harness.equal(panel.tooltipNeedsFreshData, true,
                  "and the applet is told to keep collecting for it");
    panel.destroy();
};

cases["destroying the presenter lets go of the reading it kept"] = function () {
    let calls = [];
    let panel = presenter(calls);
    panel.update(reading({ primary: battery() }), options());
    panel.destroy();
    let after = calls.length;
    /* Nothing is written for a reading that is no longer held. */
    Harness.equal(calls.length, after, "destroy writes nothing further");
};
