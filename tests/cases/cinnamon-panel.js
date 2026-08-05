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
    let style = "color: red; padding: 4px;";
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
    Harness.equal(style, "color: red; padding: 4px; text-align: left;",
                  "multiline alignment preserves Cinnamon's inline declarations");
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
    Harness.equal(style, "color: red; padding: 4px;", "theme style restored exactly");
    Harness.deepEqual(lifecycle, [true, false, true, false],
                      "active tooltip closed for its consumer");
    panel.destroy();
};

cases["incomplete private tooltip hooks do not mutate the actor"] = function () {
    let style = "padding: 6px;";
    let styleWrites = 0;
    let tooltip = {
        _tooltip: {
            get_style: () => style,
            set_style: value => { style = value; styleWrites++; },
        },
        show: function () {},
        /* no private hide hook: this integration is not usable */
    };
    let nextId = 0;
    let actor = {
        connect: () => ++nextId,
        disconnect: () => {},
    };
    let applet = publicApplet([], actor);
    applet._applet_tooltip = tooltip;

    let panel = new CinnamonPanel.PanelAdapter(applet);
    Harness.ok(panel.hasTooltipLifecycle, "the public hover fallback remains available");
    Harness.equal(styleWrites, 0, "validation happens before any private actor mutation");
    Harness.equal(style, "padding: 6px;", "the existing inline style is untouched");
    panel.destroy();
};

cases["unwritable private tooltip hooks roll back before fallback"] = function () {
    let originalShow = function () {};
    let originalHide = function () {};
    let tooltip = { show: originalShow };
    Object.defineProperty(tooltip, "hide", {
        configurable: false,
        enumerable: true,
        value: originalHide,
        writable: false,
    });
    let nextId = 0;
    let actor = {
        connect: () => ++nextId,
        disconnect: () => {},
    };
    let applet = publicApplet([], actor);
    applet._applet_tooltip = tooltip;

    let panel = new CinnamonPanel.PanelAdapter(applet);
    Harness.ok(panel.hasTooltipLifecycle, "the public fallback replaces unusable hooks");
    Harness.equal(tooltip.show, originalShow, "a partial show replacement is rolled back");
    Harness.equal(tooltip.hide, originalHide, "the private hide hook remains untouched");
    panel.destroy();
};

cases["a tooltip style failure restores the original without losing lifecycle"] = function () {
    let style = "padding: 3px;";
    let writes = 0;
    let tooltip = {
        visible: false,
        _tooltip: {
            get_style: () => style,
            set_style: value => {
                style = value;
                writes++;
                if (writes === 1)
                    throw new Error("theme rejected alignment");
            },
        },
        show: function () { this.visible = true; },
        hide: function () { this.visible = false; },
    };
    let applet = publicApplet([], null);
    applet._applet_tooltip = tooltip;

    let panel = new CinnamonPanel.PanelAdapter(applet);
    Harness.ok(panel.hasTooltipLifecycle, "styling is optional to the valid lifecycle hooks");
    Harness.equal(style, "padding: 3px;", "the failed mutation restores the exact style");
    Harness.equal(writes, 2, "one attempted mutation and one recovery write");
    panel.destroy();
    Harness.equal(writes, 2, "teardown does not restore an unapplied style a second time");
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

cases["partial hover fallback wiring is rolled back"] = function () {
    for (let second of [0, "throw"]) {
        let disconnected = [];
        let calls = 0;
        let actor = {
            connect: function () {
                calls++;
                if (calls === 1)
                    return 41;
                if (second === "throw")
                    throw new Error("leave-event unavailable");
                return second;
            },
            disconnect: id => disconnected.push(id),
        };
        let panel = new CinnamonPanel.PanelAdapter(publicApplet([], actor));
        Harness.ok(!panel.hasTooltipLifecycle, "partial wiring is not published");
        Harness.deepEqual(disconnected, [41], "the first signal is released immediately");
        panel.destroy();
        Harness.deepEqual(disconnected, [41], "teardown does not own rolled-back wiring");
    }
};

cases["tooltip teardown continues after a private restoration failure"] = function () {
    let originalShow = function () {};
    let originalHide = function () {};
    let show = originalShow;
    let showWrites = 0;
    let style = "padding: 2px;";
    let tooltip = {
        visible: false,
        hide: originalHide,
        _tooltip: {
            get_style: () => style,
            set_style: value => { style = value; },
        },
    };
    Object.defineProperty(tooltip, "show", {
        configurable: true,
        get: () => show,
        set: value => {
            showWrites++;
            if (showWrites > 1)
                throw new Error("show became read-only");
            show = value;
        },
    });
    let applet = publicApplet([], null);
    applet._applet_tooltip = tooltip;
    let panel = new CinnamonPanel.PanelAdapter(applet);

    panel.destroy();
    Harness.equal(tooltip.hide, originalHide, "the independent hide hook is restored");
    Harness.equal(style, "padding: 2px;", "tooltip styling is still restored");
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
