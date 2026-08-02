/*
 * cinnamon-powertoys
 *
 * A Cinnamon applet that puts a power icon in the panel and, from a single
 * menu, monitors and configures power management for the whole machine:
 * batteries of any device type, power profiles, CPU governor / energy
 * preference / boost, temperatures, fans and power draw.
 */

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;
const UPowerGlib = imports.gi.UPowerGlib;
const Util = imports.misc.util;

/*
 * Cinnamon loads every xlet file through misc/fileUtils.js, which hands the
 * module a require() already bound to the xlet's own directory. Using it
 * instead of imports.searchPath keeps these libraries private to this applet,
 * where imports.lib.* would have registered them under a global name any other
 * xlet could collide with, and lets a reload pick up library edits: Cinnamon
 * drops the cached modules for the directory when the xlet is unloaded, while
 * the legacy importer caches them for the life of the process.
 */
const Backlight = require("./lib/backlight.js");
const Bluez = require("./lib/bluez.js");
const Cpu = require("./lib/cpu.js");
const Ddc = require("./lib/ddc.js");
const Device = require("./lib/device.js");
const IO = require("./lib/io.js");
const Log = require("./lib/log.js");
const PowerSupply = require("./lib/power-supply.js");
const Privileged = require("./lib/privileged.js");
const Sensors = require("./lib/sensors.js");
const Translate = require("./lib/gettext.js");
const UPower = require("./lib/upower.js");
const Profiles = require("./lib/profiles.js");
const Format = require("./lib/format.js");

const UUID = Translate.UUID;
const _ = Translate._;

/*
 * St appends "-symbolic" when it loads an icon as one, and the xapp set is
 * shipped only under that suffix, so a name has to be asked for both ways
 * before it counts as missing.
 */
Format.setIconLookup(function (name) {
    let theme = Gtk.IconTheme.get_default();
    return theme.has_icon(name + "-symbolic") || theme.has_icon(name);
});

const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

const HELPER = "powertoys-helper";

/*
 * Where `make install-policy` puts a root owned copy of the helper, and the
 * path the polkit action names. When it is there, one authentication covers a
 * run of changes; when it is not, the applet runs its own copy and pkexec
 * asks every time.
 *
 * The action deliberately does not name the copy inside the applet directory.
 * That one lives under the user's home, and an authorisation that is kept for
 * a few minutes must apply to a file its caller cannot rewrite in the
 * meantime.
 */
const SYSTEM_HELPER = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";

const DEFAULT_ICON = "powertoys";
/*
 * How often the set of sensors is looked at again.
 *
 * Discovery is expensive - every hwmon directory listed, every label read -
 * and hardware does not come and go often, so this is deliberately slow. The
 * check itself is three directory listings and only leads to a sweep when
 * something has actually changed.
 */
const REDISCOVER_SECONDS = 60;

/*
 * How long the wheel has to stop for before a profile change is applied.
 *
 * One flick of a finger sends several clicks, and each one used to be its own
 * D-Bus write, so a flick meant the daemon switching profiles two or three
 * times in a few tens of milliseconds. Long enough to gather a flick, short
 * enough that the change still feels immediate.
 */
const SCROLL_SETTLE_MS = 250;

/* Charge limits offered in the menu, in percent. */
const CHARGE_LIMITS = [60, 70, 80, 90, 95, 100];

/*
 * Everything the applet reads the machine through, gathered in one bag. The
 * applet holds no direct reference to the sysfs, UPower or profile modules, so
 * handing it a different bag - a fixture directory, a stubbed bus - is enough
 * to construct it without a real machine underneath. The indirection is here
 * for the tests; at runtime this is always what gets passed.
 */
function defaultBackends() {
    return {
        sensors: () => new Sensors.SensorSet(),
        cpuControl: runner => new Cpu.CpuControl(runner),
        chargeControl: runner => PowerSupply.discoverChargeControl(runner),
        platformProfile: () => PowerSupply.platformProfile(),
        profilesClient: onChanged => new Profiles.PowerProfilesClient(onChanged),
        backlight: (kind, onChanged, onReady) =>
            new Backlight.BacklightControl(kind, onChanged, onReady),
        monitorBacklight: (onChanged, onReady) => new Ddc.DdcBacklight(onChanged, onReady),
        bluetoothBatteries: onChanged => new Bluez.BluezBatteries(onChanged),
        upowerMonitor: (onChanged, onReady) => new UPower.UPowerMonitor(onChanged, onReady),
        fileExists: path => IO.exists(path),
        privilegedHelper: (candidates, exists, repair) =>
            new Privileged.PrivilegedHelper(candidates, exists, repair),
    };
}

/*
 * Every setting this applet binds, and what has to happen when it moves.
 *
 * The property names used to be produced from the keys by a string transform,
 * so a key that was not in the schema bound to nothing and left an undefined
 * property, which reads as "off" everywhere it is used - a switch that cannot
 * be turned on, and no error to say why. Written out, the pair is checked
 * once at bind time and a mismatch is reported instead of silently obeyed.
 *
 * Most of these only need the applet to draw itself again. The ones that do
 * not say so, so that changing the temperature unit does not fold a submenu
 * and picking a panel icon does not re-register the hotkeys.
 */
const SETTINGS = [
    { key: "refresh-interval", property: "refreshInterval", onChange: "poll" },
    { key: "temp-unit", property: "tempUnit", onChange: "unit" },
    { key: "cpu-sensor-hint", property: "cpuSensorHint" },

    { key: "panel-icon-source", property: "panelIconSource", onChange: "icon" },
    { key: "panel-show-battery", property: "panelShowBattery" },
    { key: "panel-show-power", property: "panelShowPower" },
    { key: "panel-show-frequency", property: "panelShowFrequency" },
    { key: "panel-show-profile", property: "panelShowProfile" },

    { key: "show-profiles", property: "showProfiles" },
    { key: "show-cpu", property: "showCpu" },
    { key: "show-devices", property: "showDevices" },
    { key: "show-sensors", property: "showSensors" },
    { key: "show-all-sensors", property: "showAllSensors" },
    { key: "expand-sections", property: "expandSections", onChange: "expand" },
    { key: "monitor-brightness", property: "monitorBrightness" },

    /* Not shown anywhere: whether this install has introduced itself yet. */
    { key: "introduced", property: "introduced" },

    { key: "enable-privileged-controls", property: "enablePrivilegedControls" },
    { key: "scroll-action", property: "scrollAction" },
    { key: "middle-click-action", property: "middleClickAction" },
    { key: "cycle-profile-hotkey", property: "cycleProfileHotkey", onChange: "hotkeys" },
    { key: "toggle-menu-hotkey", property: "toggleMenuHotkey", onChange: "hotkeys" },

    { key: "notify-low-battery", property: "notifyLowBattery" },
    { key: "low-battery-threshold", property: "lowBatteryThreshold" },
    { key: "critical-battery-threshold", property: "criticalBatteryThreshold" },
    { key: "notify-peripheral-battery", property: "notifyPeripheralBattery" },
    { key: "peripheral-battery-threshold", property: "peripheralBatteryThreshold" },
    { key: "notify-high-temp", property: "notifyHighTemp" },
    { key: "high-temp-threshold", property: "highTempThreshold" },
    { key: "high-temp-threshold-fahrenheit", property: "highTempThresholdFahrenheit" },
];

/*
 * The power figure is not one thing: on battery it is what the battery is
 * losing, on a desktop it is the CPU package or the graphics card. They are
 * different enough that showing the number without saying which would be
 * misleading, so the source is always named alongside it.
 */
function powerSourceLabel(source) {
    switch (source) {
        case "battery": return _("battery");
        case "package": return _("package");
        case "gpu": return _("GPU");
        default: return "";
    }
}

function powerText(data) {
    if (data.systemWatts === null)
        return "";
    let label = powerSourceLabel(data.systemWattsSource);
    return Format.watts(data.systemWatts) + (label ? " (" + label + ")" : "");
}

/*
 * The same figure for the panel, where every character is expensive.
 *
 * What a battery is losing is the whole machine and needs no explanation. The
 * other two sources are one part of it - the processor package, a graphics
 * card - and a bare number there reads as system power when it is not: a
 * desktop that cannot read its RAPL counters would show the graphics card's
 * 54 W as if it were the lot. Those say which.
 */
function panelPowerText(data) {
    if (data.systemWattsSource === "battery")
        return Format.watts(data.systemWatts);
    return powerText(data);
}

/*
 * What a privileged change did, in the words the menu uses for it.
 *
 * The argument vectors are the helper's vocabulary, and this is the one place
 * that turns them back into something worth reading.
 */
function describeChange(args) {
    switch (args[0]) {
        case "governor":
            return _("Governor") + ": " + Format.governorLabel(args[1]);
        case "epp":
            return _("Energy preference") + ": " + Format.energyPreferenceLabel(args[1]);
        case "boost":
            return String(args[1]) === "1" ? _("Turbo boost on") : _("Turbo boost off");
        case "platform-profile":
            return _("Power profile") + ": " + Format.profileLabel(args[1]);
        case "charge-threshold":
            return _("Charge limit") + ": " + args[1] + "%";
        default:
            return "";
    }
}

/*
 * When to say something, and how not to say it twice.
 *
 * Each poll hands over the reading and the limits in force; this decides
 * whether any of it is news. A device that has already been reported stays
 * quiet until it recovers, and recovering means climbing five points clear of
 * the limit, so one sitting exactly on it does not alternate.
 *
 * Nothing here touches a widget or reads a setting of its own, so a run of
 * readings can be pushed through it and the notifications counted.
 */
class AlertPolicy {
    constructor(notify) {
        this._notify = notify || function (urgent, title, body) {
            if (urgent)
                Main.criticalNotify(title, body);
            else
                Main.notify(title, body);
        };
        this._alerted = new Map();
        this._tempAlerted = false;
    }

    check(data, limits) {
        for (let device of data.devices)
            this._checkDevice(device, limits);
        this._forgetAbsent(data.devices);
        this._checkTemperature(data.cpuTemperature, limits);
    }

    /*
     * A device that has been reported is remembered so it is not reported
     * again, and it used to be remembered until it was seen back above its
     * limit. A headset switched off while low never got that far, so it kept
     * its entry for the session - and came back at the same level to silence.
     */
    _forgetAbsent(devices) {
        let present = new Set(devices.map(device => device.path));
        for (let path of Array.from(this._alerted.keys())) {
            if (!present.has(path))
                this._alerted.delete(path);
        }
    }

    _checkDevice(device, limits) {
        if (device.percentage === null)
            return;

        let system = device.powerSupply;
        let enabled = system ? limits.lowBattery : limits.peripheralBattery;
        let threshold = Device.lowThreshold(device, limits.lowLevel, limits.peripheralLevel);
        let level = this._alerted.get(device.path) || "";

        if (!enabled || !Device.isDraining(device)) {
            this._alerted.delete(device.path);
            return;
        }

        if (system && device.percentage <= limits.criticalLevel) {
            if (level !== "critical") {
                this._alerted.set(device.path, "critical");
                this._notify(true, _("Battery critically low"),
                             Format.deviceTitle(device) + " - " +
                             Format.percent(device.percentage));
            }
        } else if (device.percentage <= threshold) {
            if (level === "") {
                this._alerted.set(device.path, "low");
                this._notify(false, _("Battery low"),
                             Format.deviceTitle(device) + " - " +
                             Format.percent(device.percentage));
            }
        } else if (device.percentage > threshold + 5) {
            /* hysteresis, so a device hovering at the limit is not noisy */
            this._alerted.delete(device.path);
        }
    }

    _checkTemperature(celsius, limits) {
        if (!limits.highTemp || celsius === null) {
            this._tempAlerted = false;
            return;
        }
        if (celsius >= limits.highTempCelsius) {
            if (!this._tempAlerted) {
                this._tempAlerted = true;
                this._notify(false, _("High temperature"),
                             Format.temperature(celsius, limits.tempUnit, 1));
            }
        } else if (celsius < limits.highTempCelsius - 5) {
            this._tempAlerted = false;
        }
    }
}

/*
 * The panel item: the text beside the icon, the icon, and the tooltip.
 *
 * It is given the applet only to reach the four calls that put something on
 * the panel - label, symbolic icon, icon actor and tooltip - and reads
 * nothing back out of it. What to show arrives with each update.
 */
class PanelPresenter {
    constructor(applet, iconDir) {
        this._applet = applet;
        this._iconDir = iconDir;
        this._iconKey = null;

        /*
         * Themes centre tooltips, which is right for the one-line label most
         * applets have and wrong for a stack of "Governor: Performance"
         * lines, where centring leaves every colon in a different place. An
         * inline style beats the theme rule.
         */
        let tooltip = applet._applet_tooltip;
        if (tooltip && tooltip._tooltip)
            tooltip._tooltip.set_style("text-align: left;");
    }

    update(data, options) {
        this._applet.set_applet_label(this._labelText(data, options));
        this._updateIcon(data, options.iconSource);
        this._applet.set_applet_tooltip(this._tooltipText(data, options));
    }

    /* The icon actor is rebuilt from scratch by a panel resize or an
     * orientation change, so the cache has to be dropped with it. */
    invalidateIcon() {
        this._iconKey = null;
    }

    /*
     * The text beside the icon.
     *
     * Temperature is deliberately not among the choices. A number that moves
     * every few seconds in the corner of the eye is the one thing on a panel
     * that will not be ignored, and this one is not actionable: nobody acts
     * on 61 rather than 59. It is still in the tooltip, in the menu summary
     * and in the processor section, where it is looked at on purpose.
     */
    _labelText(data, options) {
        let parts = [];
        if (options.showBattery && data.primary && data.primary.percentage !== null)
            parts.push(Format.percent(data.primary.percentage));
        if (options.showPower && data.systemWatts !== null)
            parts.push(panelPowerText(data));
        if (options.showFrequency && data.cpu.averageFrequency !== null)
            parts.push(Format.frequency(data.cpu.averageFrequency));
        if (options.showProfile && data.profile.active)
            parts.push(Format.profileLabel(data.profile.active));
        return parts.join(" ");
    }

    _updateIcon(data, source) {
        source = source || "auto";
        if (source === "auto")
            source = data.primary ? "battery" : (data.profile.active ? "profile" : "static");

        if (source === "battery" && data.primary) {
            let icon = data.primary.icon;
            let key = "battery:" + icon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            this._applet.set_applet_icon_symbolic_name(Format.batteryIconName());
            if (icon)
                this._applet._applet_icon.gicon = Gio.icon_new_for_string(icon);
            return;
        }

        let profileIcon = source === "profile" && data.profile.active
            ? Format.profileIconName(data.profile.active) : null;
        if (profileIcon) {
            let key = "profile:" + profileIcon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            /*
             * Loaded from the applet's own directory by path rather than by
             * name. These three carry colour, so asking for them as symbolic
             * names would have the theme repaint all three in the panel
             * foreground and make them identical; asking by name at all
             * depends on the icon theme having noticed the applet's directory,
             * which it does not always do until something makes it rescan.
             */
            this._applet.set_applet_icon_path(this._iconDir + "/" + profileIcon + ".svg");
            return;
        }

        let key = "symbolic:" + DEFAULT_ICON;
        if (key === this._iconKey)
            return;
        this._iconKey = key;
        this._applet.set_applet_icon_symbolic_name(DEFAULT_ICON);
    }

    _tooltipText(data, options) {
        let lines = [];

        if (data.primary) {
            lines.push(Format.deviceKindName(data.primary.kind) + " " +
                       Format.percent(data.primary.percentage) + " - " +
                       Format.deviceStateName(data.primary.state));
            let remaining = Device.remainingText(data.primary);
            if (remaining)
                lines.push(remaining);
        } else if (data.lineOnline || !data.upowerAvailable) {
            lines.push(_("Running on AC power"));
        }

        if (data.profile.active)
            lines.push(_("Profile") + ": " + Format.profileLabel(data.profile.active));
        if (data.cpu.governor)
            lines.push(_("Governor") + ": " + Format.governorLabel(data.cpu.governor));
        if (data.cpuTemperature !== null)
            lines.push(_("Temperature") + ": " +
                       Format.temperature(data.cpuTemperature, options.tempUnit, 1));
        if (data.systemWatts !== null)
            lines.push(_("Power draw") + ": " + powerText(data));

        let peripherals = data.devices.filter(device => !device.powerSupply &&
                                                        device.percentage !== null);
        for (let device of peripherals)
            lines.push(Format.deviceTitle(device) + ": " + Format.percent(device.percentage));

        if (lines.length === 0)
            lines.push(_("Power Toys"));
        return lines.join("\n");
    }
}

/*
 * Menu rows that follow a list of values.
 *
 * Tearing a section down on every poll would drop whatever the pointer is
 * over and make the menu flicker, so the widgets are rebuilt only when the set
 * of keys changes; the rest of the time the rows that are already there are
 * handed the new values. Each entry is an object carrying a "key" plus
 * whatever create and update need.
 */
class KeyedList {
    constructor(section, create, update) {
        this._section = section;
        this._create = create;
        this._update = update || function () {};
        this._key = null;
        this._items = new Map();
    }

    sync(entries) {
        let key = entries.map(entry => entry.key).join(",");
        if (key !== this._key) {
            this._key = key;
            this._section.removeAll();
            this._items = new Map();
            for (let entry of entries) {
                let item = this._create(entry);
                this._items.set(entry.key, item);
                this._section.addMenuItem(item);
            }
        }
        for (let entry of entries)
            this._update(this._items.get(entry.key), entry);
    }

    get items() {
        return Array.from(this._items.values());
    }
}

/* A non reactive "label ......... value" line. */
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init(label, value) {
        super._init.call(this, { reactive: false });

        this._label = new St.Label({ text: label, style_class: "powertoys-info-label" });
        this._value = new St.Label({ text: value || "", style_class: "powertoys-info-value" });

        this.addActor(this._label);
        this.addActor(this._value, { expand: true, span: -1, align: St.Align.END });
    }

    setLabel(text) {
        this._label.set_text(text || "");
    }

    setValue(text) {
        this._value.set_text(text || "");
    }

    setWarning(warning) {
        if (warning)
            this._value.add_style_class_name("powertoys-warning");
        else
            this._value.remove_style_class_name("powertoys-warning");
    }
}

/*
 * Two line entry for one powered device: title with icon, details below.
 *
 * It is handed a view model and sets what it is told. It used to be handed
 * the applet instead, and call back into it for the sentence, the limit and
 * whether the device was draining, which meant a row could not exist without
 * a running applet behind it.
 */
class DeviceRow extends PopupMenu.PopupBaseMenuItem {
    _init(model) {
        super._init.call(this, { reactive: false });

        this._icon = new St.Icon({ icon_size: 16,
                                   icon_type: St.IconType.SYMBOLIC,
                                   style_class: "popup-menu-icon" });
        this._title = new St.Label({ text: "" });
        this._details = new St.Label({ text: "", style_class: "powertoys-device-details" });

        let header = new St.BoxLayout({ style_class: "powertoys-device-header" });
        header.add_actor(this._icon);
        header.add_actor(this._title);

        let box = new St.BoxLayout({ vertical: true });
        box.add_actor(header);
        box.add_actor(this._details);

        this.addActor(box, { expand: true, span: -1 });

        this.update(model);
    }

    update(model) {
        this._title.set_text(model.title);
        this._details.set_text(model.details);

        /* Setting an icon name that has not changed still costs a texture
         * lookup, and this runs on every poll. */
        if (model.icon !== this._iconName) {
            this._iconName = model.icon;
            this._icon.icon_name = model.icon;
        }

        if (model.warning)
            this._details.add_style_class_name("powertoys-warning");
        else
            this._details.remove_style_class_name("powertoys-warning");
    }
}

/* Radio style entry used for profiles, governors and energy preferences. */
class SelectorItem extends PopupMenu.PopupMenuItem {
    _init(label, value, selected, onActivate) {
        super._init.call(this, label);
        this.value = value;
        this.setShowDot(selected);
        this.connect("activate", () => onActivate(value));
    }

    setSelected(selected) {
        this.setShowDot(selected);
    }
}

/*
 * A radio group: an optional bold title, then one dot item per value.
 *
 * Power profiles, governors, energy preferences and charge limits are all the
 * same widget, and the first three change their option list while the applet
 * runs - the daemon appears, the scaling driver is swapped, the privileged
 * controls are turned off - so the list rides on KeyedList and only the dots
 * move on an ordinary update.
 */
class SelectorGroup {
    constructor(section, labelFunction, onActivate, title) {
        this._title = title || "";
        this._list = new KeyedList(
            section,
            entry => entry.header
                ? this._createHeader()
                : new SelectorItem(labelFunction(entry.value), entry.value, false, onActivate),
            (item, entry) => {
                if (!entry.header)
                    item.setSelected(entry.value === entry.active);
            });
    }

    _createHeader() {
        let header = new PopupMenu.PopupMenuItem(this._title, { reactive: false });
        header.actor.add_style_class_name("powertoys-group-title");
        return header;
    }

    /* An empty value list clears the group, which is how a section hides. */
    sync(values, active) {
        let entries = [];
        if (values.length > 0 && this._title)
            entries.push({ key: "title", header: true });
        for (let value of values)
            entries.push({ key: "v:" + value, value: value, active: active });
        this._list.sync(entries);
    }

    get items() {
        return this._list.items.filter(item => item instanceof SelectorItem);
    }
}

/*
 * One kernel setting in the menu.
 *
 * With the privileged controls on it is a radio group; with them off the value
 * is still worth reading, so the same setting shows as a single
 * "label ... value" row instead. Both belong to the control, so callers pass a
 * list, the active value and whether it may be changed, rather than lining two
 * widgets up against a visibility matrix themselves.
 */
class ChoiceControl {
    constructor(menu, title, labelFunction, onActivate) {
        this._labelFunction = labelFunction;
        this._row = new InfoRow(title, "");
        menu.addMenuItem(this._row);

        let section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(section);
        this._group = new SelectorGroup(section, labelFunction, onActivate, title);
    }

    sync(values, active, editable) {
        this._group.sync(editable ? values : [], active);
        this._row.setValue(this._labelFunction(active));
        this._row.actor.visible = !editable && !!active;
    }

    get items() {
        return this._group.items;
    }
}

/* Brightness moves in steps a panel can actually show; asking for every value
 * the pointer passes over would be a D-Bus call per motion event. */
const BACKLIGHT_STEP = 5;

/*
 * A backlight as a menu row: an icon, a slider, and the value in the tooltip.
 *
 * The row stays hidden until the daemon has confirmed there is a backlight
 * behind it, so a desktop with none never sees a slider that does nothing.
 */
class BacklightSlider extends PopupMenu.PopupSliderMenuItem {
    _init(label, iconName, control) {
        super._init.call(this, 0);

        this._control = control;
        this._name = label;
        this._seeking = false;
        this.actor.hide();

        this._icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC,
                                   icon_size: 16 });
        this.removeActor(this._slider);
        this.addActor(this._icon, { span: 0 });
        this.addActor(this._slider, { span: -1, expand: true });

        this.tooltip = new Tooltips.Tooltip(this.actor, label);

        this.connect("drag-begin", () => { this._seeking = true; });
        this.connect("drag-end", () => { this._seeking = false; });
        this.connect("value-changed", (item, value) => this._onDragged(value));
    }

    _onDragged(value) {
        let wanted = Math.round(value * 100 / BACKLIGHT_STEP) * BACKLIGHT_STEP;
        if (wanted === this._control.percentage)
            return;
        this._control.setPercentage(wanted, () => this._showValue());
    }

    /*
     * Called when the control has news: the daemon has answered, or something
     * else has moved this backlight - a function key, the settings daemon
     * dimming on idle. Ignored mid-drag, where the handle would fight the
     * pointer.
     */
    sync() {
        this.actor.visible = this._control.available;
        if (!this._control.available || this._seeking)
            return;
        this.setValue((this._control.percentage || 0) / 100);
        this._showValue();
    }

    _showValue() {
        let text = this._name;
        if (this._control.percentage !== null)
            text += ": " + this._control.percentage + "%";
        this.tooltip.set_text(text);
    }

    /* The daemon owns the notch size, and it is the one the brightness keys
     * use, so the wheel and the keyboard agree. */
    _onScrollEvent(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            this._control.step(true, () => this.sync());
        else if (direction === Clutter.ScrollDirection.DOWN)
            this._control.step(false, () => this.sync());
    }
}

/*
 * The menu, from the summary line at the top to the settings entry at the
 * bottom.
 *
 * It owns its widgets and updates them from a reading plus the options that
 * say what to show. It reads no setting and touches no backend: what the user
 * clicks is reported through the actions it was handed, and everything it
 * displays arrives as an argument.
 *
 */
class MenuPresenter {
    constructor(menu, actions, capabilities, backlights) {
        this._menu = menu;
        this._actions = actions;
        this._build(capabilities || {}, backlights || {});
    }

    /*
     * One panel per subject.
     *
     * The menu used to be one column of everything: the summary, three
     * sliders, the profiles, the chargers, the devices, then two submenus and
     * a third for the charge limit. Fifteen rows at rest, and the boundaries
     * between what belongs with what were separators and nothing else.
     *
     * Now there are three panels - Performance, Devices, Sensors - and each
     * carries a summary of itself in its own label, so the menu at rest reads
     * as three lines that answer the three questions this applet exists for.
     * The sliders stay outside because a slider you have to open a panel to
     * reach is a slider nobody uses.
     */
    _build(capabilities, backlights) {
        this._summary = new InfoRow("", "");
        this._summary.actor.add_style_class_name("powertoys-summary");
        this._menu.addMenuItem(this._summary);

        /* Brightness sits at the top because it is the control in here that
         * gets used most, and because that is where the applet this one can
         * replace keeps it. Each slider hides itself when there is no such
         * backlight. */
        this._backlightSliders = [];
        if (backlights.screen)
            this._addBacklight(_("Brightness"), "display-brightness", backlights.screen);
        if (backlights.monitor)
            this._addBacklight(_("Monitor brightness"), "display-brightness",
                               backlights.monitor);
        if (backlights.keyboard)
            this._addBacklight(_("Keyboard backlight"), "keyboard-brightness",
                               backlights.keyboard);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildPerformancePanel();
        this._buildDevicePanel(capabilities);
        this._buildSensorPanel();

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addSettingsAction(_("System power settings"), "power");

        let configure = new PopupMenu.PopupIconMenuItem(_("Configure Power Toys"),
                                                        "system-run", St.IconType.SYMBOLIC);
        configure.connect("activate", () => this._actions.configure());
        this._menu.addMenuItem(configure);

        /* Which build this is. Worth a line: the version in metadata.json is
         * what the Applets manager lists, and someone reporting a problem
         * should not have to go and look it up. */
        if (capabilities.version) {
            let about = new InfoRow(_("Power Toys"), capabilities.version);
            about.actor.add_style_class_name("powertoys-about");
            this._menu.addMenuItem(about);
        }
    }

    /*
     * Everything about how hard the machine is being asked to work: which
     * power profile is in force, and the processor settings underneath it.
     * They belong together because they are two levels of the same decision -
     * the profile is what most people will touch, the governor and the energy
     * preference are what it sets.
     */
    _buildPerformancePanel() {
        this._performanceMenu = new PopupMenu.PopupSubMenuMenuItem(_("Performance"));
        this._menu.addMenuItem(this._performanceMenu);
        let menu = this._performanceMenu.menu;

        let profileSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(profileSection);
        this._profileGroup = new SelectorGroup(profileSection, Format.profileLabel,
                                               value => this._actions.setProfile(value),
                                               _("Power profile"));

        this._degradedRow = new InfoRow(_("Performance limited"), "");
        this._degradedRow.setWarning(true);
        this._degradedRow.actor.hide();
        menu.addMenuItem(this._degradedRow);

        this._cpuSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._cpuSection);
        this._buildCpuSection(this._cpuSection);
    }

    /*
     * Anything with a charge in it, and the one setting that governs how full
     * a battery is allowed to get.
     */
    _buildDevicePanel(capabilities) {
        this._deviceMenu = new PopupMenu.PopupSubMenuMenuItem(_("Batteries and devices"));
        this._menu.addMenuItem(this._deviceMenu);
        let menu = this._deviceMenu.menu;

        /* The charger goes above the batteries: whether it is plugged in is
         * the first thing anyone opening this on a laptop wants. */
        let lineSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(lineSection);
        this._lineList = new KeyedList(lineSection,
                                       entry => new InfoRow(entry.label, entry.value),
                                       (row, entry) => {
                                           row.setLabel(entry.label);
                                           row.setValue(entry.value);
                                       });

        let deviceSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(deviceSection);
        this._deviceList = new KeyedList(deviceSection,
                                         entry => new DeviceRow(entry.model),
                                         (row, entry) => row.update(entry.model));

        /* An empty panel is indistinguishable from a broken one. Say which. */
        this._noDevicesRow = new InfoRow(_("Nothing with a battery is connected"), "");
        this._noDevicesRow.actor.hide();
        menu.addMenuItem(this._noDevicesRow);

        if (capabilities.chargeLimit) {
            let chargeSection = new PopupMenu.PopupMenuSection();
            menu.addMenuItem(chargeSection);
            this._chargeGroup = new SelectorGroup(chargeSection, limit => limit + "%",
                                                  value => this._actions.setChargeLimit(value),
                                                  _("Charge limit"));
        }
    }

    _buildSensorPanel() {
        this._sensorMenu = new PopupMenu.PopupSubMenuMenuItem(_("Sensors"));
        this._menu.addMenuItem(this._sensorMenu);

        /* Only ever shown when the preferred sensor setting names something
         * this machine does not have. Somebody who typed a name has no other
         * way of finding out it was ignored. */
        this._hintRow = new InfoRow("", "");
        this._hintRow.setWarning(true);
        this._hintRow.actor.hide();
        this._sensorMenu.menu.addMenuItem(this._hintRow);

        /*
         * The rows live in a section of their own, because KeyedList clears
         * what it is given whenever the set of sensors changes - and anything
         * else sharing that menu would be destroyed along with them.
         */
        let listSection = new PopupMenu.PopupMenuSection();
        this._sensorMenu.menu.addMenuItem(listSection);
        this._sensorList = new KeyedList(listSection,
                                         entry => entry.heading
                                             ? this._createHeading(entry.label)
                                             : new InfoRow(entry.label, entry.value),
                                         (row, entry) => {
                                             if (entry.heading)
                                                 return;
                                             row.setValue(entry.value);
                                             row.setWarning(entry.warning);
                                         });
    }

    /*
     * The sliders alone, without touching anything else.
     *
     * A backlight changing says nothing about batteries, sensors or the
     * processor, and the control already knows its own new value, so there is
     * nothing to go and read.
     */
    syncBacklights() {
        for (let slider of this._backlightSliders)
            slider.sync();
    }

    _createHeading(text) {
        let heading = new PopupMenu.PopupMenuItem(text, { reactive: false });
        heading.actor.add_style_class_name("powertoys-group-title");
        return heading;
    }

    _addBacklight(label, iconName, control) {
        let slider = new BacklightSlider(label, iconName, control);
        this._menu.addMenuItem(slider);
        this._backlightSliders.push(slider);
    }

    _buildCpuSection(menu) {
        this._cpuFreqRow = new InfoRow(_("Frequency"), "");
        this._cpuTempRow = new InfoRow(_("Temperature"), "");
        this._cpuDriverRow = new InfoRow(_("Scaling driver"), "");
        menu.addMenuItem(this._cpuFreqRow);
        menu.addMenuItem(this._cpuTempRow);
        menu.addMenuItem(this._cpuDriverRow);

        this._governorControl = new ChoiceControl(menu, _("Governor"), Format.governorLabel,
                                                  value => this._actions.setGovernor(value));
        this._energyControl = new ChoiceControl(menu, _("Energy preference"),
                                                Format.energyPreferenceLabel,
                                                value => this._actions.setEnergyPreference(value));

        /* The switch carries its own read-only mode, so unlike the two lists
         * above it needs no second widget: insensitive still shows the state. */
        this._boostSwitch = new PopupMenu.PopupSwitchMenuItem(_("Turbo boost"), false);
        this._boostSwitch.connect("toggled", (item, state) => this._actions.setBoost(state));
        menu.addMenuItem(this._boostSwitch);
    }

    /* Submenus start folded; "expand-sections" asks for them open instead. */
    applyExpandState(expand) {
        for (let item of [this._performanceMenu, this._deviceMenu, this._sensorMenu]) {
            if (!item)
                continue;
            if (expand)
                item.menu.open(false);
            else
                item.menu.close(false);
        }
    }

    update(data, options) {
        this.syncBacklights();
        this._updateSummary(data, options);
        this._updateProfiles(data, options);
        this._updateDevices(data, options);
        this._updateCpu(data, options);
        this._updateSensors(data, options);
        this._updateCharge(data, options);
    }

    _updateSummary(data, options) {
        if (data.primary) {
            this._summary.setLabel(Format.deviceKindName(data.primary.kind) + " " +
                                   Format.percent(data.primary.percentage));
            let detail = Format.deviceStateName(data.primary.state);
            let remaining = Device.remainingText(data.primary);
            if (remaining)
                detail += " · " + remaining;
            this._summary.setValue(detail);
        } else {
            this._summary.setLabel(_("On AC power"));
            let detail = [];
            if (data.cpuTemperature !== null)
                detail.push(Format.temperature(data.cpuTemperature, options.tempUnit, 1));
            if (data.systemWatts !== null)
                detail.push(powerText(data));
            this._summary.setValue(detail.join(" · "));
        }
    }

    _updateProfiles(data, options) {
        let show = options.showProfiles && data.profile.available && data.profile.list.length > 0;
        /* The dot follows what was asked for, not what has arrived: a
         * selection that springs back for a second while the daemon thinks
         * about it reads as the click having missed. */
        let active = options.pendingProfile || data.profile.active;
        this._profileGroup.sync(show ? data.profile.list : [], active);

        this._performanceMenu.actor.visible = show || (options.showCpu && data.cpu.available);
        this._setPanelSummary(this._performanceMenu, _("Performance"),
                              show ? Format.profileLabel(active)
                                   : Format.governorLabel(data.cpu.governor));

        let notes = [];
        if (data.profile.degraded)
            notes.push(data.profile.degraded.replace(/-/g, " "));
        for (let hold of data.profile.holds) {
            let application = hold.application || _("an application");
            notes.push(application + " → " + Format.profileLabel(hold.profile));
        }
        if (show && notes.length > 0) {
            this._degradedRow.setValue(notes.join(", "));
            this._degradedRow.actor.show();
        } else {
            this._degradedRow.actor.hide();
        }
    }

    _updateDevices(data, options) {
        let lines = options.showDevices ? data.lines : [];
        let devices = options.showDevices ? data.devices : [];

        this._deviceMenu.actor.visible = options.showDevices;
        this._lineList.sync(lines.map(device => ({
            key: device.path,
            label: Format.deviceTitle(device),
            value: device.online ? _("Connected") : _("Disconnected"),
        })));
        this._deviceList.sync(devices.map(device => ({
            key: device.path,
            model: Device.viewModel(device, options),
        })));

        /*
         * An empty panel and a broken one look the same, and on a desktop
         * whose bluetooth mouse happens to be switched off this panel is
         * empty for a perfectly good reason. Say which it is.
         */
        this._noDevicesRow.actor.visible = lines.length === 0 && devices.length === 0;

        this._setPanelSummary(this._deviceMenu, _("Batteries and devices"),
                              this._deviceSummary(data, devices, lines));
    }

    _deviceSummary(data, devices, lines) {
        if (data.primary && data.primary.percentage !== null)
            return Format.percent(data.primary.percentage);
        let counted = devices.length + lines.length;
        return counted === 0 ? _("none") : String(counted);
    }

    /*
     * A panel says what is inside it without being opened. Three closed rows
     * that each answer a question beats three that each promise an answer.
     */
    _setPanelSummary(item, title, value) {
        item.label.set_text(value ? title + "   " + value : title);
    }

    _updateCpu(data, options) {
        let show = options.showCpu && data.cpu.available;
        this._cpuSection.actor.visible = show;
        if (!show)
            return;

        let frequency = Format.frequency(data.cpu.averageFrequency);
        if (data.cpu.maxFrequency)
            frequency += " / " + Format.frequency(data.cpu.maxFrequency);
        this._cpuFreqRow.setValue(frequency);

        this._cpuTempRow.actor.visible = data.cpuTemperature !== null;
        if (data.cpuTemperature !== null) {
            this._cpuTempRow.setValue(Format.temperature(data.cpuTemperature, options.tempUnit, 1));
            this._cpuTempRow.setWarning(data.cpuTemperature >= options.highTempCelsius);
        }

        this._cpuDriverRow.setValue(Format.driverLabel(data.cpu.driver, data.cpu.amdPstateStatus));

        /* While a privileged change is in flight there is a password dialog
         * on screen and a second click can only queue behind it, so the
         * controls say so rather than pretending to be ready. */
        let editable = options.privileged && !options.busy;
        this._governorControl.sync(data.cpu.governors, data.cpu.governor, editable);
        this._energyControl.sync(data.cpu.energyPreferences, data.cpu.energyPreference, editable);

        this._boostSwitch.actor.visible = data.cpu.boostSupported;
        if (data.cpu.boostSupported) {
            if (data.cpu.boostEnabled !== null)
                this._boostSwitch.setToggleState(data.cpu.boostEnabled);
            this._boostSwitch.setSensitive(editable);
        }
    }

    /*
     * A menu key unique across the three lists. Ids are unique within one of
     * them but not between them: a battery that reports both a temperature
     * and a draw carries the same UPower path in each, and what tells the two
     * readings apart is what they measure.
     */
    _entryKey(reading) {
        return reading.measure + ":" + reading.id;
    }

    /* A temperature is worth flagging as it closes on the chip's own limit. */
    _temperatureEntry(sensor, options) {
        return {
            key: this._entryKey(sensor),
            kind: sensor.kind,
            measure: sensor.measure,
            label: sensor.label,
            value: Format.temperature(sensor.celsius, options.tempUnit, 1),
            warning: sensor.critical !== null && sensor.celsius >= sensor.critical - 5,
        };
    }

    _fanEntry(fan) {
        return { key: this._entryKey(fan), kind: fan.kind, measure: fan.measure,
                 label: fan.label, value: Format.rpm(fan.rpm), warning: false };
    }

    _powerEntry(meter) {
        return { key: this._entryKey(meter), kind: meter.kind, measure: meter.measure,
                 label: meter.label, value: Format.watts(meter.watts), warning: false };
    }

    /*
     * One kind of reading turned into menu entries: drop what cannot be read,
     * drop the uninteresting kinds unless the menu was asked for all of them.
     */
    _sensorEntries(readings, showAll, isReadable, toEntry) {
        let usable = readings.filter(isReadable);
        if (!showAll)
            usable = usable.filter(reading => Sensors.isPrimaryKind(reading.kind));
        return usable.map(toEntry);
    }

    /*
     * Everything a card or a chip has to say, together.
     *
     * Kind first, so the processor's readings are in one place and the
     * graphics card's in another; then temperature, fan, power within a kind,
     * because that is the order of interest; then by name. Sorting the three
     * measures separately would have put a card's fan speed several rows
     * below its temperature with another chip's readings in between.
     */
    _bySensorGroup(a, b) {
        let byKind = Sensors.kindRank(a.kind) - Sensors.kindRank(b.kind);
        if (byKind !== 0)
            return byKind;
        const ORDER = ["temperature", "fan", "power"];
        let byMeasure = ORDER.indexOf(a.measure) - ORDER.indexOf(b.measure);
        if (byMeasure !== 0)
            return byMeasure;
        return a.label === b.label ? 0 : (a.label < b.label ? -1 : 1);
    }

    /*
     * A heading wherever the kind changes.
     *
     * With every sensor shown this list is nineteen rows on the machine it
     * was written on, and nineteen undifferentiated rows is a wall. Four
     * headed groups of two to seven is a list. The names come from the kind
     * table, which has carried them since PT-40 without anything rendering
     * them.
     */
    _withHeadings(entries) {
        let out = [];
        let kind = null;
        for (let entry of entries) {
            if (entry.kind !== kind) {
                kind = entry.kind;
                out.push({ key: "heading:" + kind, heading: true, label: Sensors.kindLabel(kind) });
            }
            out.push(entry);
        }
        return out;
    }

    _updateSensors(data, options) {
        this._sensorMenu.actor.visible = options.showSensors;
        if (!options.showSensors)
            return;

        this._setPanelSummary(this._sensorMenu, _("Sensors"),
                              data.cpuTemperature === null ? ""
                              : Format.temperature(data.cpuTemperature, options.tempUnit, 1));

        this._hintRow.actor.visible = data.hintMatched === false;
        if (data.hintMatched === false)
            this._hintRow.setLabel(_("No sensor matches") + " \u201c" + options.sensorHint + "\u201d");

        let all = options.showAllSensors;
        let entries = [].concat(
            this._sensorEntries(data.temperatures, all, sensor => sensor.celsius !== null,
                                sensor => this._temperatureEntry(sensor, options)),
            this._sensorEntries(data.fans, all, fan => fan.rpm !== null && fan.rpm > 0,
                                fan => this._fanEntry(fan)),
            this._sensorEntries(data.powers, all, () => true,
                                meter => this._powerEntry(meter)));

        if (entries.length === 0) {
            this._sensorList.sync([{ key: "empty", label: _("No sensors found"),
                                     value: "", warning: false }]);
            return;
        }

        entries.sort((x, y) => this._bySensorGroup(x, y));
        this._sensorList.sync(this._withHeadings(entries));
    }

    /* A group inside the devices panel now, so it is beside the battery it
     * applies to rather than being a submenu of its own. */
    _updateCharge(data, options) {
        if (!this._chargeGroup)
            return;
        this._chargeGroup.sync(options.privileged && !options.busy ? CHARGE_LIMITS : [],
                               data.chargeLimit);
    }
}

/*
 * The applet itself: the wiring, and only the wiring.
 *
 * It binds the settings, builds the backends, owns the poll timer, assembles
 * one reading from those backends, hands that reading to the panel, the menu
 * and the alert policy, and turns what the user does - a click, the wheel, a
 * hotkey - into a call on a backend. It draws nothing and decides nothing
 * about how anything looks.
 *
 * Four groups here are still more than wiring, and each is somebody else's
 * item: choosing between the two profile backends (PT-32), what a device row
 * says about itself (PT-33, PT-34), and running the privileged helper
 * (PT-37).
 */
class PowerToysApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId, backends) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this.instanceId = instanceId;
        this._backends = backends || defaultBackends();
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_show_label_in_vertical_panels(false);

        /*
         * Set when the applet leaves the panel. Everything that can be
         * reached from outside - a D-Bus reply, a spawned process finishing,
         * an idle callback - checks it, because those arrive whenever they
         * arrive and the applet they were started for may be gone by then.
         */
        this._destroyed = false;

        this._timerId = 0;
        this._scrollTimerId = 0;
        this._pendingScroll = 0;
        this._pendingProfile = null;
        this._alerts = new AlertPolicy();
        this._panel = new PanelPresenter(this, metadata.path + "/icons");
        this._hotkeyIds = [];

        this._bindSettings();

        this._helper = this._backends.privilegedHelper(
            [SYSTEM_HELPER, metadata.path + "/" + HELPER],
            path => this._backends.fileExists(path),
            path => this._ensureExecutable(path));

        this._sensors = this._backends.sensors();
        this._cpu = this._backends.cpuControl((args, onDone) => this._runHelper(args, onDone));
        this._chargeControl =
            this._backends.chargeControl((args, onDone) => this._runHelper(args, onDone));

        this._backlights = {
            screen: this._backends.backlight(Backlight.SCREEN,
                                             () => this._onBacklightChanged(),
                                             () => this._onScreenBacklightKnown()),
            keyboard: this._backends.backlight(Backlight.KEYBOARD,
                                               () => this._onBacklightChanged(),
                                               () => this._onBacklightChanged()),
        };
        /*
         * Monitors on a cable have no kernel backlight and have to be talked
         * to over DDC/CI. The control exists from the start so the menu can
         * hold a row for it, but it does not go looking for a monitor until
         * it is told to - see _onScreenBacklightKnown().
         */
        this._backlights.monitor = this._backends.monitorBacklight(
            () => this._onBacklightChanged(),
            () => this._onBacklightChanged());

        /* Bluetooth devices UPower does not bridge - which on some builds is
         * all of them - reported by BlueZ itself. */
        this._bluetooth = this._backends.bluetoothBatteries(() => this._scheduleUpdate());

        this._profiles = this._backends.profilesClient(() => this._scheduleUpdate());
        this._upower = this._backends.upowerMonitor(() => this._scheduleUpdate(),
                                                    () => this._scheduleUpdate());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._createMenu(orientation);

        this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event));
        this.actor.connect("button-press-event", (actor, event) => this._onButtonPress(actor, event));

        this._registerHotkeys();
        this._startPolling();
        this._update();
        this._introduce();
    }

    /* ------------------------------------------------------------------ */
    /* settings                                                            */

    _bindSettings() {
        this.settings = new Settings.AppletSettings(this, UUID, this.instanceId);

        let handlers = {
            /* the default: the reading has not changed, only what is made of it */
            redraw: () => this._update(),
            icon: () => {
                this._panel.invalidateIcon();
                this._update();
            },
            poll: () => this._startPolling(),
            unit: () => this._onTempUnitChanged(),
            /* on its own, so toggling anything else does not fold a submenu
             * the user opened by hand */
            expand: () => this._menuPresenter.applyExpandState(this.expandSections),
            hotkeys: () => this._registerHotkeys(),
        };

        for (let setting of SETTINGS) {
            let handler = handlers[setting.onChange || "redraw"];
            this.settings.bind(setting.key, setting.property, handler);
        }

        this._reportUnboundSettings();
        this._tempUnitInUse = this.tempUnit;
    }

    /*
     * A key that is not in the schema binds without complaint and leaves its
     * property undefined, and undefined reads as "off" at every one of the
     * places that use it. Saying so once, at startup, is the difference
     * between a five minute fix and a puzzling bug report.
     */
    /*
     * The first run, and only the first.
     *
     * Nobody reads a README before using a panel applet, and there is not
     * much to go on otherwise: on a desktop the applet is an icon with no
     * text beside it, and everything it can do is behind three panels that
     * are folded shut. So it says once what is in there, and opens them the
     * first time the menu is used - showing being better than telling.
     */
    _introduce() {
        if (this.introduced)
            return;
        this.settings.setValue("introduced", true);
        this._openPanelsOnce = true;

        Main.notify(_("Power Toys"),
                    _("Power profiles, processor settings, batteries and sensors " +
                      "are in this menu. Right click the panel to configure it."));
    }

    /*
     * The settings daemon has said whether this machine has a backlight of
     * its own. If it has, that is the one to use and nothing needs to go
     * poking at the I2C bus; if it has not, a monitor on a cable is the only
     * screen there is, and DDC/CI is the only way to reach it.
     */
    _onScreenBacklightKnown() {
        if (this.monitorBrightness && !this._backlights.screen.available)
            this._backlights.monitor.start();
        this._onBacklightChanged();
    }

    /*
     * A backlight moved - a function key, the daemon dimming on idle, the
     * slider itself. Only the sliders need to hear about it: nothing else in
     * the menu or the panel depends on a backlight, and the control already
     * knows its new value, so there is nothing to go and read.
     */
    _onBacklightChanged() {
        if (!this._destroyed && this._menuPresenter)
            this._menuPresenter.syncBacklights();
    }

    _reportUnboundSettings() {
        let missing = SETTINGS
            .filter(setting => this[setting.property] === undefined)
            .map(setting => setting.key);
        if (missing.length > 0)
            Log.error("these settings did not bind, so settings-schema.json and the " +
                      "SETTINGS table disagree: " + missing.join(", "));
    }

    /*
     * The high temperature limit is kept as two settings, one per unit, so it
     * is always typed in the unit the rest of the applet is showing; only the
     * one matching the current unit is revealed by the settings window. They
     * are two views of a single limit, so switching the unit carries the value
     * across rather than leaving a stale number in the other key.
     */
    _onTempUnitChanged() {
        let previous = this._tempUnitInUse;
        this._tempUnitInUse = this.tempUnit;
        if (previous && previous !== this.tempUnit) {
            if (this.tempUnit === "fahrenheit")
                this.settings.setValue("high-temp-threshold-fahrenheit",
                                       Math.round(this.highTempThreshold * 9 / 5 + 32));
            else
                this.settings.setValue("high-temp-threshold",
                                       Math.round((this.highTempThresholdFahrenheit - 32) * 5 / 9));
        }
        this._onSettingsChanged();
    }

    /* Sensors are read in Celsius, so every comparison happens there. */
    get highTempCelsius() {
        if (this.tempUnit === "fahrenheit")
            return (this.highTempThresholdFahrenheit - 32) * 5 / 9;
        return this.highTempThreshold;
    }

    _onSettingsChanged() {
        this._update();
    }

    /* ------------------------------------------------------------------ */
    /* menu construction                                                   */

    /*
     * Creating and throwing away the menu happens in one place: an orientation
     * change replaces it wholesale, and it has to leave the menu manager as
     * cleanly as it entered it.
     */
    _createMenu(orientation) {
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open)
                this._onMenuOpened();
        });

        this._menuPresenter = new MenuPresenter(this.menu, this._menuActions(),
                                               { chargeLimit: !!this._chargeControl,
                                                 version: this.metadata.version },
                                               this._backlights);
        this._menuPresenter.applyExpandState(this.expandSections);
    }

    /* What the menu is allowed to ask for. Every one of these ends in a write
     * the applet is responsible for, which is why the menu does not do them. */
    _menuActions() {
        return {
            setProfile: name => this._setProfile(name),
            setGovernor: value => this._cpu.setGovernor(value),
            setEnergyPreference: value => this._cpu.setEnergyPreference(value),
            setBoost: state => this._cpu.setBoost(state),
            setChargeLimit: value => this._chargeControl.setLimit(value),
            configure: () => Util.spawnCommandLine("cinnamon-settings applets " +
                                                   UUID + " " + this.instanceId),
        };
    }

    _menuOptions() {
        return {
            tempUnit: this.tempUnit,
            showProfiles: this.showProfiles,
            showDevices: this.showDevices,
            showCpu: this.showCpu,
            showSensors: this.showSensors,
            showAllSensors: this.showAllSensors,
            privileged: this.enablePrivilegedControls,
            highTempCelsius: this.highTempCelsius,
            /* what a device row colours itself against */
            lowLevel: this.lowBatteryThreshold,
            peripheralLevel: this.peripheralBatteryThreshold,
            sensorHint: (this.cpuSensorHint || "").trim(),
            /* a change the machine has not confirmed yet */
            pendingProfile: this._pendingProfile,
            busy: this._helper.busy,
        };
    }

    _destroyMenu() {
        if (!this.menu)
            return;
        this.menuManager.removeMenu(this.menu);
        this.menu.destroy();
        this.menu = null;
        this._menuPresenter = null;
    }

    /* ------------------------------------------------------------------ */
    /* data collection                                                     */

    /*
     * One reading of the whole machine.
     *
     * Each backend describes its own part; what is left here is putting the
     * parts side by side and answering the two questions that need more than
     * one of them - which sensor the panel shows, and which of several
     * numbers counts as the machine's power draw.
     */
    _collect() {
        let upower = this._upower.read();
        let readings = this._sensors.read(this._sensorFilter());
        /* Anything with a charge that UPower did not mention. */
        let devices = upower.devices.concat(this._bluetooth.missingFrom(upower.devices));

        let temperatures = readings.temperatures.concat(upower.temperatures);
        let powers = readings.powers.concat(upower.powers);
        let power = this._pickPower(upower.primary, readings.packageWatts, powers);
        let picked = this._pickTemperature(temperatures);

        return {
            upowerAvailable: upower.available,
            devices: devices,
            lines: upower.lines,
            primary: upower.primary,
            onBattery: upower.onBattery,
            lineOnline: upower.lineOnline,
            temperatures: temperatures,
            fans: readings.fans,
            powers: powers,
            packageWatts: readings.packageWatts,
            cpu: this._cpu.snapshot(),
            profile: this._collectProfile(),
            chargeLimit: this._chargeControl ? this._chargeControl.limit : null,
            cpuTemperature: picked.sensor === null ? null : picked.sensor.celsius,
            /* which sensor that came from, and whether the user's hint is
             * the reason - false means they asked for one and it was not
             * found, which is worth saying out loud */
            temperatureSensorId: picked.sensor === null ? null : picked.sensor.id,
            hintMatched: picked.hintMatched,
            systemWatts: power.watts,
            systemWattsSource: power.source,
        };
    }

    /*
     * Which sensors are worth reading at all.
     *
     * The menu shows the interesting kinds unless it was asked for every one,
     * and reading the rest costs more than everything else in a poll put
     * together. A sensor named by the user's hint is kept whatever its kind,
     * or setting the hint to a disk would quietly stop working.
     */
    _sensorFilter() {
        let all = this.showAllSensors;
        let hint = (this.cpuSensorHint || "").trim();
        return function (sensor) {
            if (all || Sensors.isPrimaryKind(sensor.kind))
                return true;
            return hint !== "" && Sensors.sensorMatches(sensor, hint);
        };
    }

    /*
     * Which profile backend is answering. power-profiles-daemon when it is
     * running, otherwise the ACPI platform profile - which is read from sysfs
     * and written through the helper, so the reading says which it was.
     */
    _collectProfile() {
        if (this._profiles.available)
            return {
                available: true,
                backend: this._profiles.busName,
                active: this._profiles.active,
                list: this._profiles.profiles,
                degraded: this._profiles.degraded,
                holds: this._profiles.holds,
                viaSysfs: false,
            };

        let platform = this._backends.platformProfile();
        if (platform && platform.choices.length > 0)
            return {
                available: true,
                backend: "acpi-platform-profile",
                active: platform.active,
                list: platform.choices,
                degraded: "",
                holds: [],
                viaSysfs: true,
            };

        return {
            available: false,
            backend: null,
            active: null,
            list: [],
            degraded: "",
            holds: [],
            viaSysfs: false,
        };
    }

    /*
     * The sensor shown in the panel: the user's hint first, then the one a
     * CPU calls its own, then a GPU, then whatever is left.
     *
     * Matching is on what the driver calls the sensor, not on the name the
     * menu shows, which is composed for reading and could be composed
     * differently tomorrow. The settings tooltip says "chip or label
     * fragment", and that is now literally what is compared.
     */
    _pickTemperature(temperatures) {
        let readable = temperatures.filter(sensor => sensor.celsius !== null);
        if (readable.length === 0)
            return { sensor: null, hintMatched: null };

        let hint = (this.cpuSensorHint || "").trim();
        if (hint) {
            let match = readable.find(sensor => Sensors.sensorMatches(sensor, hint));
            if (match)
                return { sensor: match, hintMatched: true };
        }

        /* What the common processor drivers call the reading that stands for
         * the whole package: AMD's Tctl and Tdie, Intel's "Package id 0", and
         * the SoC thermal zones that have only a type. */
        let matched = hint === "" ? null : false;
        let preferred = ["tctl", "tdie", "package id 0", "cpu"];
        let cpus = readable.filter(sensor => sensor.kind === "cpu");
        for (let name of preferred) {
            let match = cpus.find(sensor => Sensors.sensorMatches(sensor, name));
            if (match)
                return { sensor: match, hintMatched: matched };
        }
        if (cpus.length > 0)
            return { sensor: cpus[0], hintMatched: matched };

        let gpu = readable.find(sensor => sensor.kind === "gpu");
        return { sensor: gpu || readable[0], hintMatched: matched };
    }

    /* Battery drain is the honest number while on battery; otherwise fall back
     * to the RAPL package counter and finally to the GPU meters. The source is
     * reported alongside the value, since these measure very different things. */
    _pickPower(primary, packageWatts, powers) {
        if (primary && primary.state === UPDeviceState.DISCHARGING && primary.energyRate)
            return { watts: primary.energyRate, source: "battery" };
        if (packageWatts !== null)
            return { watts: packageWatts, source: "package" };
        let gpus = powers.filter(entry => entry.kind === "gpu");
        if (gpus.length > 0)
            return { watts: gpus.reduce((total, entry) => total + entry.watts, 0), source: "gpu" };
        return { watts: null, source: null };
    }

    /* ------------------------------------------------------------------ */
    /* update                                                              */

    _scheduleUpdate() {
        if (this._destroyed || this._idleId)
            return;
        this._idleId = Mainloop.idle_add(() => {
            this._idleId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startPolling() {
        this._stopPolling();
        let interval = Math.max(1, this.refreshInterval || 4);
        this._sinceRediscover = 0;
        this._timerId = Mainloop.timeout_add_seconds(interval, () => {
            /*
             * A card that wakes up, a USB sensor plugged in, a driver loaded.
             * Opening the menu used to be the only thing that noticed, which
             * since the menu stopped updating while shut meant the panel
             * could go the whole session without seeing new hardware.
             */
            this._sinceRediscover += interval;
            if (this._sinceRediscover >= REDISCOVER_SECONDS) {
                this._sinceRediscover = 0;
                this._sensors.refresh();
            }
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._timerId) {
            Mainloop.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _onMenuOpened() {
        /* Cheap, and only sweeps again if something moved. The poll does this
         * too, on a much slower cadence; here it is because someone opening
         * the menu wants what is true now. */
        this._sensors.refresh();
        this._sinceRediscover = 0;
        this._cpu.refresh();
        if (this._upower.available)
            this._upower.refresh();
        for (let name in this._backlights)
            this._backlights[name].refresh(() => this._onBacklightChanged());
        this._update();

        /* Only ever on the very first menu of a fresh install. */
        if (this._openPanelsOnce) {
            this._openPanelsOnce = false;
            this._menuPresenter.applyExpandState(true);
        }
    }

    _update() {
        if (this._destroyed)
            return;

        let data;
        try {
            data = this._collect();
        } catch (error) {
            Log.error("collection failed: " + error);
            return;
        }
        /* The machine has caught up with what was asked for. */
        if (this._pendingProfile && data.profile.active === this._pendingProfile)
            this._pendingProfile = null;

        this._latest = data;
        this._panel.update(data, this._panelOptions());

        /*
         * The panel is always on screen; the menu usually is not. Composing
         * rows nobody can see costs a formatted string per row per poll, and
         * through the lazily read frequency a file per cpufreq policy as
         * well. The menu is brought up to date when it opens, which is the
         * only moment its contents can be looked at.
         */
        if (this._menuPresenter && this.menu && this.menu.isOpen)
            this._menuPresenter.update(data, this._menuOptions());

        this._alerts.check(data, this._alertLimits());
    }

    _panelOptions() {
        return {
            showBattery: this.panelShowBattery,
            showPower: this.panelShowPower,
            showFrequency: this.panelShowFrequency,
            showProfile: this.panelShowProfile,
            iconSource: this.panelIconSource,
            tempUnit: this.tempUnit,
        };
    }

    _alertLimits() {
        return {
            lowBattery: this.notifyLowBattery,
            peripheralBattery: this.notifyPeripheralBattery,
            lowLevel: this.lowBatteryThreshold,
            peripheralLevel: this.peripheralBatteryThreshold,
            criticalLevel: this.criticalBatteryThreshold,
            highTemp: this.notifyHighTemp,
            highTempCelsius: this.highTempCelsius,
            tempUnit: this.tempUnit,
        };
    }

    /* ------------------------------------------------------------------ */
    /* actions                                                             */

    /*
     * Asking for a profile, and remembering that it was asked for.
     *
     * Neither backend answers immediately - the daemon replies over D-Bus,
     * the ACPI path goes through a password dialog - and until one of them
     * does, the menu was still showing the old selection. So the obvious
     * thing to do was click again, which sent a second write for a change
     * already in flight.
     */
    _setProfile(name) {
        if (name === this._pendingProfile)
            return;
        this._pendingProfile = name;

        let data = this._latest;
        if (data && data.profile.viaSysfs) {
            /* the helper reports its own failures */
            this._runHelper(["platform-profile", name], outcome => {
                if (!outcome.applied)
                    this._pendingProfile = null;
            });
        } else {
            this._profiles.setProfile(name, error => {
                if (error) {
                    this._pendingProfile = null;
                    this._notifyProfileError(name, error);
                }
                this._scheduleUpdate();
            });
        }
        this.menu.close();
        this._scheduleUpdate();
    }

    /* Gio prefixes a remote error with the D-Bus error name, which means
     * nothing to the person reading the notification. */
    _notifyProfileError(name, error) {
        let detail = error && error.message ? error.message : String(error);
        detail = detail.replace(/^GDBus\.Error:[^\s:]+:\s*/, "").trim();
        Main.notifyError(_("Power Toys"),
                         _("Could not switch to") + " " + Format.profileLabel(name) +
                         (detail ? ": " + detail : ""));
    }

    /*
     * The profile block collected on the last poll, whether it comes from
     * power-profiles-daemon or from the ACPI platform profile. Everything that
     * changes a profile goes through this, so no caller has to know which
     * backend is in use.
     */
    _profileState() {
        let state = this._latest ? this._latest.profile : null;
        if (!state || !state.available || state.list.length === 0)
            return null;
        return state;
    }

    /* Known names first, so stepping always runs power saver, balanced,
     * performance, with anything unusual the backend offers appended. */
    _orderedProfiles(state) {
        let ordered = Profiles.PROFILE_ORDER.filter(name => state.list.indexOf(name) >= 0);
        for (let name of state.list) {
            if (ordered.indexOf(name) < 0)
                ordered.push(name);
        }
        return ordered;
    }

    _stepProfile(step, wrap, announce) {
        let state = this._profileState();
        if (!state)
            return false;

        let ordered = this._orderedProfiles(state);
        let index = ordered.indexOf(state.active);
        if (index < 0)
            index = 0;

        let target = index + step;
        if (wrap)
            target = (target + ordered.length) % ordered.length;
        else
            target = Math.max(0, Math.min(ordered.length - 1, target));

        let name = ordered[target];
        if (name === state.active)
            return false;

        this._setProfile(name);
        if (announce)
            Main.notify(_("Power Toys"), _("Power profile") + ": " + Format.profileLabel(name));
        return true;
    }

    _cycleProfile() {
        this._stepProfile(1, true, true);
    }

    /*
     * Governor, energy preference, boost and charge limit are root owned, so
     * they go through a small validating helper launched with pkexec.
     *
     * The gate is here rather than inside the helper: whether the user has
     * allowed these changes at all is a setting, and a setting is the
     * applet's business. What the helper answers is turned into a
     * notification here too, because deciding what is worth interrupting
     * somebody for is not something a library should do.
     */
    _runHelper(args, onDone) {
        if (!this.enablePrivilegedControls)
            return;

        /* So the menu shows the change as in flight straight away rather
         * than when the helper answers. */
        this._scheduleUpdate();

        this._helper.run(args, outcome => {
            if (this._destroyed)
                return;

            this._cpu.refresh();
            this._update();

            if (outcome.applied) {
                /*
                 * A privileged change ends with a password dialog and then,
                 * until now, nothing - so the last thing that happened was
                 * being asked for a password, and whether it worked had to be
                 * inferred from the menu reading differently next time it was
                 * opened. Say what changed.
                 *
                 * Power profiles are not confirmed this way and do not need
                 * to be: the panel icon is green, yellow or red, and it
                 * changes colour as they take effect.
                 */
                let changed = describeChange(args);
                if (changed)
                    Main.notify(_("Power Toys"), changed);
                if (onDone)
                    onDone(outcome);
                return;
            }

            /* Cancelled means the user closed the dialog or the password did
             * not check out; they do not need telling what they just did. */
            if (!outcome.cancelled)
                Main.notifyError(_("Power Toys"),
                                 outcome.error || _("The change could not be applied."));
            if (onDone)
                onDone(outcome);
        });
    }

    /* A checkout or a zip download can lose the executable bit. */
    _ensureExecutable(path) {
        try {
            let file = Gio.File.new_for_path(path);
            let info = file.query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null);
            let mode = info.get_attribute_uint32("unix::mode");
            if ((mode & 0o111) !== 0o111)
                file.set_attribute_uint32("unix::mode", (mode | 0o755) & 0o7777,
                                          Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            /* read only install, the helper is most likely already executable */
        }
    }

    /*
     * The wheel counts, and the count is applied once it settles.
     *
     * Three clicks in one direction means three steps, clamped at the ends -
     * the wheel should stop at performance rather than come round again at
     * power saver - and it reaches the daemon as one write instead of three.
     */
    _onScroll(actor, event) {
        let direction = event.get_scroll_direction();
        let up = direction === Clutter.ScrollDirection.UP;
        if (!up && direction !== Clutter.ScrollDirection.DOWN)
            return Clutter.EVENT_PROPAGATE;

        /*
         * Brightness, which is what the applet this one replaces does with
         * the wheel. The daemon owns the step size, so this moves by the same
         * amount the brightness keys do.
         */
        if (this.scrollAction === "brightness") {
            let control = this._brightnessControl();
            if (!control)
                return Clutter.EVENT_PROPAGATE;
            control.step(up, () => this._onBacklightChanged());
            return Clutter.EVENT_STOP;
        }

        if (this.scrollAction !== "profile" || !this._profileState())
            return Clutter.EVENT_PROPAGATE;

        if (direction === Clutter.ScrollDirection.UP)
            this._pendingScroll += 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            this._pendingScroll -= 1;
        else
            return Clutter.EVENT_PROPAGATE;

        this._cancelPendingScroll();
        this._scrollTimerId = Mainloop.timeout_add(SCROLL_SETTLE_MS, () => {
            this._scrollTimerId = 0;
            let step = this._pendingScroll;
            this._pendingScroll = 0;
            /* Announced, because the panel is not necessarily showing the
             * profile and otherwise nothing would say it had changed. */
            this._stepProfile(step, false, true);
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    /* Whichever screen this machine actually has: its own panel, or a
     * monitor on a cable. */
    _brightnessControl() {
        if (this._backlights.screen.available)
            return this._backlights.screen;
        if (this._backlights.monitor && this._backlights.monitor.available)
            return this._backlights.monitor;
        return null;
    }

    /*
     * Middle click. The stock applet toggles the keyboard backlight, which is
     * the sort of thing nobody discovers but everybody who knew about it
     * misses.
     */
    _onButtonPress(actor, event) {
        if (event.get_button() !== 2)
            return Clutter.EVENT_PROPAGATE;

        if (this.middleClickAction === "keyboard-backlight") {
            if (!this._backlights.keyboard.available)
                return Clutter.EVENT_PROPAGATE;
            this._backlights.keyboard.toggle(() => this._onBacklightChanged());
            return Clutter.EVENT_STOP;
        }

        if (this.middleClickAction === "profile" && this._profileState()) {
            this._cycleProfile();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _cancelPendingScroll() {
        if (this._scrollTimerId) {
            Mainloop.source_remove(this._scrollTimerId);
            this._scrollTimerId = 0;
        }
    }

    _registerHotkeys() {
        this._removeHotkeys();
        if (this.cycleProfileHotkey) {
            let name = UUID + "-cycle-profile-" + this.instanceId;
            Main.keybindingManager.addHotKey(name, this.cycleProfileHotkey, () => this._cycleProfile());
            this._hotkeyIds.push(name);
        }
        if (this.toggleMenuHotkey) {
            let name = UUID + "-toggle-menu-" + this.instanceId;
            Main.keybindingManager.addHotKey(name, this.toggleMenuHotkey, () => this.menu.toggle());
            this._hotkeyIds.push(name);
        }
    }

    _removeHotkeys() {
        for (let name of this._hotkeyIds)
            Main.keybindingManager.removeHotKey(name);
        this._hotkeyIds = [];
    }

    /* ------------------------------------------------------------------ */
    /* applet lifecycle                                                    */

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    on_orientation_changed(orientation) {
        this._destroyMenu();
        this._createMenu(orientation);
        this._update();
    }

    on_panel_height_changed() {
        this._panel.invalidateIcon();
        this._update();
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        this._stopPolling();
        this._cancelPendingScroll();
        if (this._idleId) {
            Mainloop.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._removeHotkeys();
        this._destroyMenu();
        if (this._profiles)
            this._profiles.destroy();
        if (this._upower)
            this._upower.destroy();
        if (this._bluetooth)
            this._bluetooth.destroy();
        for (let name in this._backlights)
            this._backlights[name].destroy();
        if (this.settings)
            this.settings.finalize();
    }
}

/* Cinnamon calls this with four arguments; the fifth is for the tests. */
function main(metadata, orientation, panelHeight, instanceId, backends) {
    return new PowerToysApplet(metadata, orientation, panelHeight, instanceId, backends);
}
