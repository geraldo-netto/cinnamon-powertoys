/* Cinnamon's private panel objects stay behind one tested compatibility edge. */

const Harness = imports.harness;
const CinnamonPanel = Harness.requireXlet("./lib/cinnamon-panel.js");

var cases = {};

function publicApplet(calls, actor) {
    return {
        actor: actor,
        set_applet_label: text => calls.push(["label", text]),
        set_applet_tooltip: text => calls.push(["tooltip", text]),
        set_applet_icon_symbolic_name: name => calls.push(["symbolic", name]),
        set_applet_icon_path: path => calls.push(["path", path]),
    };
}

cases["private tooltip hooks report reality and are restored"] = function () {
    let style = "";
    let tooltipActor = {
        get_style: () => style,
        set_style: value => { style = value; },
    };
    let tooltip = {
        visible: false,
        _tooltip: tooltipActor,
        show: function (answer) {
            this.visible = answer !== "declined";
            return answer;
        },
        hide: function (answer) {
            this.visible = false;
            return answer;
        },
    };
    let originalShow = tooltip.show;
    let originalHide = tooltip.hide;
    let calls = [];
    let lifecycle = [];
    let before = 0;
    let iconActor = { gicon: null };
    let applet = publicApplet(calls, null);
    applet._applet_tooltip = tooltip;
    applet._applet_icon = iconActor;

    let panel = new CinnamonPanel.PanelAdapter(applet, {
        beforeTooltip: () => { before++; },
        onTooltip: visible => lifecycle.push(visible),
    });
    Harness.equal(style, "text-align: left;", "multiline tooltip alignment");
    Harness.ok(panel.hasTooltipLifecycle, "private lifecycle detected");

    Harness.equal(tooltip.show("declined"), "declined", "show return value preserved");
    Harness.equal(before, 1, "text prepared before a declined show");
    Harness.deepEqual(lifecycle, [], "declined show not reported as visible");
    Harness.equal(tooltip.show("shown"), "shown", "show arguments preserved");
    Harness.ok(panel.tooltipVisible, "visible state read from Cinnamon");
    Harness.deepEqual(lifecycle, [true], "visible tooltip announced once");
    Harness.equal(tooltip.hide("hidden"), "hidden", "hide return value preserved");
    Harness.deepEqual(lifecycle, [true, false], "hidden tooltip announced");

    panel.setLabel("61%");
    panel.setTooltip("Consumption: 12 W");
    panel.setSymbolicIcon("powertoys");
    panel.setIconPath("/icons/balanced.svg");
    let gicon = {};
    Harness.ok(panel.setBatteryIcon("battery-full", gicon, "battery-good-symbolic"),
               "Gio.Icon actor available");
    Harness.equal(iconActor.gicon, gicon, "Gio.Icon applied");
    Harness.deepEqual(calls, [
        ["label", "61%"],
        ["tooltip", "Consumption: 12 W"],
        ["symbolic", "powertoys"],
        ["path", "/icons/balanced.svg"],
        ["symbolic", "battery-good"],
    ], "public applet methods used");

    tooltip.show("shown");
    panel.destroy();
    Harness.equal(tooltip.show, originalShow, "show restored");
    Harness.equal(tooltip.hide, originalHide, "hide restored");
    Harness.equal(style, "", "theme style restored exactly");
    Harness.deepEqual(lifecycle, [true, false, true, false],
                      "active tooltip closed for its consumer");
    panel.destroy();
};

cases["public hover events are the fallback and disconnect cleanly"] = function () {
    let nextId = 0;
    let handlers = {};
    let disconnected = [];
    let actor = {
        connect: function (signal, callback) {
            let id = ++nextId;
            handlers[signal] = { id: id, callback: callback };
            return id;
        },
        disconnect: id => disconnected.push(id),
    };
    let calls = [];
    let lifecycle = [];
    let before = 0;
    let panel = new CinnamonPanel.PanelAdapter(publicApplet(calls, actor), {
        beforeTooltip: () => { before++; },
        onTooltip: visible => lifecycle.push(visible),
    });

    Harness.ok(panel.hasTooltipLifecycle, "hover fallback installed");
    handlers["enter-event"].callback();
    Harness.equal(before, 1, "tooltip prepared on entry");
    Harness.ok(panel.tooltipVisible, "entry treated as visible fallback");
    handlers["leave-event"].callback();
    Harness.deepEqual(lifecycle, [true, false], "hover lifecycle announced");

    Harness.ok(!panel.setBatteryIcon("battery-full", {}, "battery-caution-symbolic"),
               "no private icon actor");
    Harness.deepEqual(calls, [["symbolic", "battery-caution"]],
                      "the current UPower state remains available publicly");
    panel.destroy();
    Harness.deepEqual(disconnected.sort(), [1, 2], "both hover hooks disconnected");
};

cases["missing shell capabilities degrade without throwing"] = function () {
    let panel = new CinnamonPanel.PanelAdapter({});
    Harness.ok(!panel.hasTooltipLifecycle, "no lifecycle invented");
    panel.setLabel("text");
    panel.setTooltip("text");
    panel.setSymbolicIcon("icon");
    panel.setIconPath("/icon.svg");
    Harness.ok(!panel.setBatteryIcon("battery", {}), "no private icon actor invented");
    panel.setBatteryIcon("battery-full", {}, "/not/an/icon");
    panel.destroy();
};
