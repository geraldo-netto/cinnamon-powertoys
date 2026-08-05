/*
 * cinnamon-powertoys
 *
 * A Cinnamon applet that puts a power icon in the panel and, from a single
 * menu, monitors and configures power management for the whole machine:
 * batteries of any device type, power profiles, CPU governor / energy
 * preference / boost, temperatures, fans and power draw.
 */

const Applet = imports.ui.applet;
const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

/*
 * Cinnamon loads every xlet file through misc/fileUtils.js, which hands the
 * module a require() already bound to the xlet's own directory. Using it
 * instead of imports.searchPath keeps these libraries private to this applet,
 * where imports.lib.* would have registered them under a global name any other
 * xlet could collide with, and lets a reload pick up library edits: Cinnamon
 * drops the cached modules for the directory when the xlet is unloaded, while
 * the legacy importer caches them for the life of the process.
 */
const Alerts = require("./lib/alerts.js");
const Backlight = require("./lib/backlight.js");
const Bluez = require("./lib/bluez.js");
const CinnamonPanel = require("./lib/cinnamon-panel.js");
const Cpu = require("./lib/cpu.js");
const Ddc = require("./lib/ddc.js");
const Device = require("./lib/device.js");
const IO = require("./lib/io.js");
const KeyedList = require("./lib/keyed-list.js");
const Log = require("./lib/log.js");
const PanelText = require("./lib/panel-text.js");
const PendingProfile = require("./lib/pending-profile.js");
const PowerSupply = require("./lib/power-supply.js");
const Privileged = require("./lib/privileged.js");
const Sensors = require("./lib/sensors.js");
const SensorRows = require("./lib/sensor-rows.js");
const Translate = require("./lib/gettext.js");
const UPower = require("./lib/upower.js");
const Profiles = require("./lib/profiles.js");
const Reading = require("./lib/reading.js");
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
 * How often monitors are looked for while somebody is looking at the applet.
 *
 * A DDC/CI probe spawns ddcutil, talks to every display on the I2C bus and
 * wakes a sleeping one, which is why this is not on the poll and why the timer
 * does not exist unless there is a reason for it - see _watchMonitors. A second
 * is what a monitor that was asleep, plugged in unnoticed or slow to answer
 * costs before its slider appears, which is about as long as somebody who has
 * just opened the menu will wait without deciding the applet cannot see it.
 */
const MONITOR_PROBE_SECONDS = 1;

/*
 * How long the wheel has to stop for before a profile change is applied.
 *
 * One flick of a finger sends several clicks, and each one used to be its own
 * D-Bus write, so a flick meant the daemon switching profiles two or three
 * times in a few tens of milliseconds. Long enough to gather a flick, short
 * enough that the change still feels immediate.
 */
const SCROLL_SETTLE_MS = 250;

/* A positive amount means the same thing as scrolling up everywhere. */
function scrollAmount(event) {
    let direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP)
        return 1;
    if (direction === Clutter.ScrollDirection.DOWN)
        return -1;
    if (direction !== Clutter.ScrollDirection.SMOOTH)
        return 0;
    try {
        let delta = event.get_scroll_delta();
        let vertical = delta && delta.length > 1 ? delta[1] : 0;
        return typeof vertical === "number" && Number.isFinite(vertical) ? -vertical : 0;
    } catch (e) {
        return 0;
    }
}

function settledScrollSteps(amount) {
    return amount < 0 ? -Math.round(-amount) : Math.round(amount);
}

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
        sensors: onChanged => new Sensors.SensorSet({
            asynchronous: true,
            onChanged: onChanged,
        }),
        cpuControl: (runner, onChanged) => new Cpu.CpuControl(runner, {
            asynchronous: true,
            onChanged: onChanged,
        }),
        chargeControl: runner => PowerSupply.discoverChargeControl(runner),
        platformProfileClient: runner => new PowerSupply.PlatformProfileClient(runner),
        profilesClient: onChanged => new Profiles.PowerProfilesClient(onChanged),
        backlight: (kind, onChanged, onReady) =>
            new Backlight.BacklightControl(kind, onChanged, onReady),
        monitorBacklight: onChanged => new Ddc.DdcBacklight(onChanged),
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
    { key: "panel-text", property: "panelText" },
    { key: "panel-show-battery", property: "panelShowBattery" },
    { key: "panel-show-power", property: "panelShowPower" },
    { key: "panel-show-profile", property: "panelShowProfile" },
    /* Not shown anywhere: whether the three above have been read once into
     * the list that replaced them. */
    { key: "panel-text-migrated", property: "panelTextMigrated" },

    { key: "show-profiles", property: "showProfiles" },
    { key: "show-cpu", property: "showCpu" },
    { key: "show-devices", property: "showDevices" },
    { key: "show-sensors", property: "showSensors" },
    { key: "show-all-sensors", property: "showAllSensors" },
    { key: "monitor-brightness", property: "monitorBrightness", onChange: "monitor" },

    /* Not shown anywhere: whether this install has introduced itself yet. */
    { key: "introduced", property: "introduced" },

    { key: "enable-privileged-controls", property: "enablePrivilegedControls" },
    { key: "scroll-action", property: "scrollAction" },
    { key: "middle-click-action", property: "middleClickAction" },
    { key: "cycle-profile-hotkey", property: "cycleProfileHotkey", onChange: "hotkeys" },
    { key: "toggle-menu-hotkey", property: "toggleMenuHotkey", onChange: "hotkeys" },

    { key: "notify-low-battery", property: "notifyLowBattery" },
    { key: "low-battery-threshold", property: "lowBatteryThreshold", onChange: "alertLevels" },
    { key: "critical-battery-threshold", property: "criticalBatteryThreshold", onChange: "alertLevels" },
    { key: "notify-peripheral-battery", property: "notifyPeripheralBattery" },
    { key: "peripheral-battery-threshold", property: "peripheralBatteryThreshold" },
    { key: "notify-high-temp", property: "notifyHighTemp" },
    { key: "high-temp-threshold", property: "highTempThreshold" },
    { key: "high-temp-threshold-fahrenheit", property: "highTempThresholdFahrenheit" },
];

/*
 * The panel item: the text beside the icon, the icon, and the tooltip.
 *
 * It is given the applet only to reach the four calls that put something on
 * the panel - label, symbolic icon, icon actor and tooltip - and reads
 * nothing back out of it. What to show arrives with each update, and what any
 * of it should say is lib/panel-text.js; what is left here is the putting.
 */
class PanelPresenter {
    constructor(applet, iconDir, onTooltip) {
        this._iconDir = iconDir;
        this._iconKey = null;
        this._reading = null;
        this._readingOptions = null;
        this._shell = new CinnamonPanel.PanelAdapter(applet, {
            beforeTooltip: () => this._writeTooltip(),
            onTooltip: onTooltip,
        });
    }

    /*
     * The icon cache, dropped.
     *
     * _updateIcon does nothing while the key it would set is the key already
     * set, which is what keeps a poll from costing a texture lookup - so
     * anything that changes what a key means has to say so here. A panel
     * resize and an orientation change rebuild the icon actor underneath it,
     * and an icon theme change moves every answer Format gives about which
     * names exist.
     *
     * It went out with the panel text in PT-161b while its three callers
     * stayed, so each of them threw before the redraw on the line beneath it -
     * and a theme change left the panel holding an icon from a theme that is
     * no longer installed, which is what PT-69 was closed for.
     */
    invalidateIcon() {
        this._iconKey = null;
    }

    update(data, options) {
        let profile = Reading.shownProfile(data, options);
        let source = PanelText.iconSource(data, options.iconSource, profile);
        this._shell.setLabel(PanelText.labelText(data, options, source, profile));
        this._updateIcon(data, source, profile);

        this._reading = data;
        this._readingOptions = options;
        if (this._shell.tooltipVisible || !this._shell.hasTooltipLifecycle)
            this._writeTooltip();
    }

    _writeTooltip() {
        if (this._reading)
            this._shell.setTooltip(PanelText.tooltipText(this._reading, this._readingOptions));
    }

    _updateIcon(data, source, profile) {
        if (source === "battery" && data.primary) {
            let icon = data.primary.icon;
            let key = "battery:" + icon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            this._shell.setBatteryIcon(Format.batteryIconName(),
                                       icon ? Gio.icon_new_for_string(icon) : null,
                                       icon);
            return;
        }

        let profileIcon = source === "profile" && profile
            ? Format.profileIconName(profile) : null;
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
            this._shell.setIconPath(this._iconDir + "/" + profileIcon + ".svg");
            return;
        }

        let key = "symbolic:" + DEFAULT_ICON;
        if (key === this._iconKey)
            return;
        this._iconKey = key;
        this._shell.setSymbolicIcon(DEFAULT_ICON);
    }

    destroy() {
        this._shell.destroy();
        this._reading = null;
        this._readingOptions = null;
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

    /* A row drawn at some other size than a reading - a heading - puts that
     * size on its text and not on itself, so that the row keeps the theme's
     * own font size and with it the theme's horizontal padding. See the
     * stylesheet, which is where the reason is spelled out. */
    addTextStyleClass(name) {
        this._label.add_style_class_name(name);
        this._value.add_style_class_name(name);
    }
}

/*
 * A line about the rows around it rather than a row among them: how many
 * monitors get a slider, who else is writing the two settings below.
 *
 * It answers nothing when the menu asks how wide its columns want to be. A
 * note is a sentence, and a sentence in the first column made that column as
 * wide as the sentence, pushing every value in the group out to the right of
 * it - one remark cost the menu a hundred and thirty pixels. It takes whatever
 * width the rows that mean something came to, and is cut off if it does not
 * fit, which is the right way round.
 */
class NoteRow extends PopupMenu.PopupBaseMenuItem {
    _init(text) {
        super._init.call(this, { reactive: false });
        this.actor.add_style_class_name("powertoys-note");
        this._label = new St.Label({ text: text });
        this._label.add_style_class_name("powertoys-note-text");
        this.addActor(this._label, { span: -1, expand: true });
    }

    setText(text) {
        this._label.set_text(text || "");
    }

    getColumnWidths() {
        return [];
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
        this._selected = selected;
        this.setShowDot(this._selected);
        this.connect("activate", () => {
            if (!this._selected)
                onActivate(value);
        });
    }

    setSelected(selected) {
        this._selected = selected;
        this.setShowDot(this._selected);
    }
}

/*
 * A radio group: a heading carrying the current value, then one dot item per
 * value.
 *
 * Governors, energy preferences and charge limits are all the same widget, and
 * the first two change their option list while the applet runs - the daemon
 * appears, the scaling driver is swapped, the privileged controls are turned
 * off - so the list rides on KeyedList and only the dots move on an ordinary
 * update.
 *
 * The heading says the value as well as the name, which it did not, and that
 * was the whole of what a glance at this group could tell you: the selection
 * was a dot four pixels wide, drawn outside the row box at the far left, on a
 * row whose text is at the right. The power profile above stopped being a list
 * like this for exactly that reason; these cannot follow it, because
 * acpi-cpufreq offers five governors and five buttons do not fit a column, so
 * they say it in words instead.
 */
class SelectorGroup {
    constructor(section, labelFunction, onActivate, title) {
        this._title = title || "";
        this._labelFunction = labelFunction;
        this._list = new KeyedList.KeyedList(
            section,
            entry => entry.header
                ? this._createHeader()
                : new SelectorItem(labelFunction(entry.value), entry.value, false, onActivate),
            (item, entry) => {
                if (entry.header)
                    item.setValue(this._valueText(entry.active));
                else
                    item.setSelected(entry.value === entry.active);
            });
    }

    _valueText(active) {
        return active === null || active === undefined ? "" : this._labelFunction(active);
    }

    _createHeader() {
        let header = new InfoRow(this._title, "");
        header.actor.add_style_class_name("powertoys-group-title");
        header.addTextStyleClass("powertoys-group-title-text");
        return header;
    }

    /* An empty value list clears the group, which is how a section hides. */
    sync(values, active) {
        let entries = [];
        if (values.length > 0 && this._title)
            entries.push({ key: "title", header: true, active: active });
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
 *
 * A list of one is not a list, so it takes the row too. amd-pstate narrows the
 * energy preferences to just "performance" while the governor is performance,
 * and what that drew was a heading, one radio item, and a dot on it: a control
 * offering a choice that does not exist, which claims the user has a say they
 * have not got.
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

    /*
     * `show` is false where this setting is not this menu's to offer - the
     * governor under a daemon that rewrites it - and the whole control goes,
     * row and list together, rather than being drawn insensitive. A control
     * nobody may use is not a control.
     */
    sync(values, active, editable, show) {
        let visible = show !== false;
        let choices = visible && editable && values.length > 1 ? values : [];
        this._group.sync(choices, active);
        this._row.setValue(this._labelFunction(active));
        this._row.actor.visible = visible && choices.length === 0 && !!active;
    }

    /* Whether anything of it is on screen, so a group holding nothing but
     * these can hide its heading too. */
    get visible() {
        return this._row.actor.visible || this._group.items.length > 0;
    }

    get items() {
        return this._group.items;
    }
}

/* Beyond this, one row competes with the three-column menu for screen width. */
const PROFILE_ROW_MAX_WIDTH = 360;
const PROFILE_ROW_MAX_CHOICES = 3;

/*
 * The power profile as a compact row, or a vertical selector when it would
 * make the menu too wide, with the active choice filled.
 *
 * As a list of three dotted rows it was three lines of the menu all reading
 * the same word - "Performance", "Performance", "Performance" - where only the
 * dot said anything, and the dot is four pixels at the far left of a row whose
 * text is at the right. As a row of buttons the choice is one object, the
 * options are read across in one movement instead of down in three, and the
 * one in force is the one that is filled in.
 *
 * The fill is grey rather than the theme's selection colour. Cinnamon's
 * stylesheet language cannot read a value out of the active theme, so an
 * applet that wants "whatever this theme highlights with" has to guess at it,
 * and a wrong guess is a coloured block that belongs to no theme at all. Grey
 * at two opacities is a difference on a light theme and on a dark one without
 * claiming to know either.
 *
 * Clicking one does not close the menu. The point of filling the active
 * segment is that the change can be seen, and it cannot be seen from a menu
 * that has just shut.
 */
class SegmentedControl extends PopupMenu.PopupBaseMenuItem {
    _init(labelFunction, onActivate) {
        /* Reactive, so the row takes key focus and the arrow keys reach it;
         * not activatable, because the row itself does nothing - the buttons
         * in it do. */
        super._init.call(this, { activate: false, hover: false });

        this._labelFunction = labelFunction;
        this._onActivate = onActivate;
        this._values = [];
        this._active = null;
        this._editable = true;
        this._buttons = new Map();

        this._box = new St.BoxLayout({ style_class: "powertoys-segmented" });
        this.addActor(this._box, { span: -1, expand: true });

        this.actor.connect("key-press-event", (actor, event) => this._onKeyPressEvent(actor, event));
    }

    /*
     * This row takes the width of its column; it does not set it.
     *
     * A menu item that spans every column still counts as being in the first
     * one when the column widths are worked out, so three buttons side by side
     * made the first column as wide as all three - and every label in the
     * column, which is only ever one word, was given that width with the value
     * pushed out beyond it. The menu came out a third wider than it had rows
     * for. Answering nothing here leaves the widths to the rows that mean
     * something by them, and the buttons divide up whatever that came to.
     */
    getColumnWidths() {
        return [];
    }

    /*
     * Its own width, though, rather than the column's.
     *
     * PopupBaseMenuItem answers get-preferred-width with whatever column
     * widths it was handed, and the method above contributes none to them - so
     * a column holding nothing else asked for the width of its headings, and
     * the three buttons were drawn as "Powe...", "Balan...", "Perfo...". That
     * did not show while the governor rows shared the column and set a width
     * for it; it appeared the moment they left it.
     *
     * The minimum is the natural width on purpose. A button too narrow for its
     * word is not a smaller button, it is a button that no longer says what it
     * does, and there is nothing else in this row to give way instead.
     */
    _getPreferredWidth(actor, forHeight, alloc) {
        let [, natural] = this._box.get_preferred_width(forHeight);
        alloc.min_size = natural;
        alloc.natural_size = natural;
    }

    sync(values, active, editable) {
        this._editable = editable !== false;
        if (values.join("\u0000") !== this._values.join("\u0000")) {
            this._values = values.slice();
            for (let child of this._box.get_children())
                child.destroy();
            this._buttons = new Map();
            for (let value of values) {
                let label = this._labelFunction(value);
                let button = new St.Button({ label: label,
                                             style_class: "powertoys-segment",
                                             can_focus: true });
                button.set_accessible_role(Atk.Role.RADIO_BUTTON);
                button.set_accessible_name(label);
                button.connect("clicked", () => {
                    if (this._editable && value !== this._active)
                        this._onActivate(value);
                });
                this._box.add(button, { expand: true, x_fill: true });
                this._buttons.set(value, button);
            }
        }

        this._active = active;
        let natural = 0;
        for (let button of this._buttons.values())
            natural += button.get_preferred_width(-1)[1];
        let vertical = values.length > PROFILE_ROW_MAX_CHOICES ||
                       natural > PROFILE_ROW_MAX_WIDTH;
        this._box.vertical = vertical;
        this._box.change_style_pseudo_class("vertical", vertical);
        /* PopupBaseMenuItem only applies setSensitive() to activatable rows;
         * this row deliberately is not one, because its child buttons act.
         * Apply the same state to the row and to those actual controls. */
        this.actor.reactive = this._editable;
        this.actor.can_focus = this._editable;
        this.actor.change_style_pseudo_class("insensitive", !this._editable);
        for (let [value, button] of this._buttons) {
            button.reactive = this._editable;
            button.can_focus = this._editable;
            if (value === active) {
                button.add_style_class_name("powertoys-segment-active");
                button.add_accessible_state(Atk.StateType.CHECKED);
            } else {
                button.remove_style_class_name("powertoys-segment-active");
                button.remove_accessible_state(Atk.StateType.CHECKED);
            }
        }
    }

    /*
     * Left and right along the row, the way a slider takes them. Up and down
     * are the menu's, so they are left alone and the row is one stop in the
     * menu rather than three.
     */
    _onKeyPressEvent(actor, event) {
        let symbol = event.get_key_symbol();
        let step = 0;
        if (symbol === Clutter.KEY_Right)
            step = 1;
        else if (symbol === Clutter.KEY_Left)
            step = -1;
        if (step === 0 || this._values.length === 0 || !this._editable)
            return false;
        if (this.actor.get_direction() === St.TextDirection.RTL)
            step = -step;

        let at = this._values.indexOf(this._active);
        let next = at < 0 ? 0 : Math.max(0, Math.min(this._values.length - 1, at + step));
        if (this._values[next] !== this._active)
            this._onActivate(this._values[next]);
        return true;
    }

    get items() {
        return Array.from(this._buttons.values());
    }
}

/* Brightness moves in steps a panel can actually show; asking for every value
 * the pointer passes over would be a D-Bus call per motion event. */
const BACKLIGHT_STEP = 5;

/*
 * A backlight as a menu row: an icon, whose screen it is, the slider, and the
 * value.
 *
 * The row stays hidden until the daemon has confirmed there is a backlight
 * behind it, so a desktop with none never sees a slider that does nothing.
 *
 * The name is on the row rather than only in the tooltip because there can be
 * several of these now - one per monitor - and a column of identical tracks
 * that only say which screen they belong to after a second of hovering is a
 * guessing game. The tooltip is kept anyway: it is where the value goes while
 * the pointer is on the row, which is exactly when the pointer is covering it.
 *
 * The row is one box rather than four menu columns because the value has to
 * sit at the right hand edge. Menu columns are as wide as their widest member
 * anywhere in the section, so the last column would have started wherever the
 * longest monitor name ended and the percentages would have been a ragged
 * line down the middle of the menu.
 */
class BacklightSlider extends PopupMenu.PopupSliderMenuItem {
    /*
     * A full span child still counts as being in the first menu column, so a
     * row this wide sitting in a column with the governor and the energy
     * preference would set that column's label width to its own and push both
     * of their values off the right hand edge. It has no columns to line up
     * with; it takes the width it is given. Same override as NoteRow and
     * SegmentedControl, for the same reason.
     */
    getColumnWidths() {
        return [];
    }

    /*
     * And its own width when asked, for the reason set out in
     * SegmentedControl: a row that contributes no column width is otherwise
     * told to ask for the other rows' widths, which have nothing to do with a
     * slider. Unlike the buttons this one may be squeezed - the name gives way
     * first - so the minimum is the row's own minimum and not its natural.
     */
    _getPreferredWidth(actor, forHeight, alloc) {
        let [min, natural] = this._row.get_preferred_width(forHeight);
        alloc.min_size = min;
        alloc.natural_size = natural;
    }

    _init(label, iconName, control) {
        super._init.call(this, 0);

        this._control = control;
        this._name = label;
        this._seeking = false;
        this._pendingScroll = 0;
        this._scrollTimerId = 0;
        this.actor.hide();

        this._icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC,
                                   icon_size: 16 });
        this._label = new St.Label({ text: label, style_class: "powertoys-slider-name" });
        this._reading = new St.Label({ text: "", style_class: "powertoys-slider-value" });

        this.removeActor(this._slider);

        /*
         * The track carries the theme's own minimum width, which is written
         * for a menu the width of a whole panel: measured here it was 206px,
         * against a column 326px wide inside its padding, and the row drew
         * over the column beside it rather than shrinking. It asks for less
         * now and still takes everything left over, which is what expand is
         * for. See the stylesheet.
         *
         * The track is the only part of the row that grows, so it gets all of
         * the width the name and the percentage do not need.
         *
         * The name is what gives when there is not enough: an ellipsized label
         * can be allocated less than its text needs, where a plain one cannot
         * and pushes the row out of the column instead. That is not a rare
         * case - a monitor answering the DDC/CI probe adds a slider to a
         * column that was measured without one, while the menu is open. The
         * tooltip has the name in full.
         */
        this._slider.add_style_class_name("powertoys-slider-track");
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        let row = new St.BoxLayout({ style_class: "powertoys-slider-row" });
        row.add(this._icon, { y_fill: false, y_align: St.Align.MIDDLE });
        row.add(this._label, { y_fill: false, y_align: St.Align.MIDDLE });
        row.add(this._slider, { expand: true, x_fill: true });
        row.add(this._reading, { y_fill: false, y_align: St.Align.MIDDLE });
        this._row = row;
        this.addActor(row, { span: -1, expand: true });

        this.actor.set_accessible_role(Atk.Role.SLIDER);
        this.actor.set_accessible_name(_("Brightness") + ": " + label);
        this._accessible = this.actor.get_accessible();
        /* Slider accessibles also implement Atk.Action, whose set_description
         * takes an action index before the text. Name Atk.Object explicitly so
         * GJS cannot resolve the colliding interface method. */
        Atk.Object.prototype.set_description.call(
            this._accessible, "0–100% · " + BACKLIGHT_STEP + "%");

        this.tooltip = new Tooltips.Tooltip(this.actor, label);

        this.connect("drag-begin", () => { this._seeking = true; });
        this.connect("drag-end", () => { this._seeking = false; });
        this.connect("value-changed", (item, value) => this._onDragged(value));
        this.actor.connect("destroy", () => {
            if (this._scrollTimerId)
                Mainloop.source_remove(this._scrollTimerId);
            this._scrollTimerId = 0;
        });
    }

    _onDragged(value) {
        let wanted = Math.round(value * 100 / BACKLIGHT_STEP) * BACKLIGHT_STEP;
        if (wanted === this._control.percentage)
            return;
        this._control.setPercentage(wanted, () => this._showValue());
    }

    /* A DDC bus is the stable identity of a row, but the monitor on that bus
     * and the control object describing it are not. KeyedList keeps the row
     * in that case, so refresh everything the constructor derived from the
     * entry before drawing its latest value. */
    adopt(label, control) {
        this._control = control;
        this._name = label;
        this._label.set_text(label);
        this.actor.set_accessible_name(_("Brightness") + ": " + label);
        this._showValue();
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
        let percentage = this._control.percentage;
        this._reading.set_text(percentage === null ? "" : percentage + "%");
        this.tooltip.set_text(percentage === null ? this._name
                                                  : this._name + ": " + percentage + "%");
        if (percentage !== null)
            this._accessible.accessible_value = percentage;
    }

    /* The daemon owns the notch size, and it is the one the brightness keys
     * use, so the wheel and the keyboard agree. */
    _onScrollEvent(actor, event) {
        let amount = scrollAmount(event);
        if (amount === 0)
            return Clutter.EVENT_PROPAGATE;

        this._pendingScroll += amount;
        if (this._scrollTimerId)
            Mainloop.source_remove(this._scrollTimerId);
        this._scrollTimerId = Mainloop.timeout_add(SCROLL_SETTLE_MS, () => {
            this._scrollTimerId = 0;
            let steps = settledScrollSteps(this._pendingScroll);
            this._pendingScroll = 0;
            if (steps !== 0)
                this._control.stepBy(steps, () => this.sync());
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }
}

/*
 * A section whose columns line up with itself and with nothing else.
 *
 * Everything in a popup menu is laid out in columns, and Cinnamon aligns them
 * across the whole menu: before it measures, the menu asks every item how wide
 * its columns want to be, takes the widest of each, and hands that back down to
 * all of them. In one column of rows that is what makes labels and values line
 * up; with the columns side by side it made each of them as wide as the widest
 * row anywhere in the menu, so one long scaling driver name in the left column
 * set the width of both and the menu came out over a thousand pixels across.
 * The brightness sliders are in one of these for the same reason, so that a
 * monitor's name does not have to line up with a sensor's.
 *
 * Breaking the chain at the boundary is two lines: tell the menu nothing, and
 * ignore what it says in favour of what this section's own rows need. Rows
 * inside a column still align with each other, including the ones in the
 * nested sections the lists live in, because those are untouched.
 */
class PanelSection extends PopupMenu.PopupMenuSection {
    getColumnWidths() {
        return [];
    }

    setColumnWidths() {
        super.setColumnWidths(super.getColumnWidths());
    }
}

/*
 * The name of a group of rows.
 *
 * Not a menu item that does anything, and deliberately not the same weight as
 * the rows it heads: a heading is furniture, and what is read in this menu is
 * the numbers.
 */
function headingItem(text) {
    let heading = new PopupMenu.PopupMenuItem(text, { reactive: false });
    heading.actor.add_style_class_name("powertoys-group-title");
    /* The size goes on the label, the padding and the opacity on the row; see
     * the stylesheet for what putting both on the row cost. */
    heading.label.add_style_class_name("powertoys-group-title-text");
    return heading;
}

/*
 * One column of the menu.
 *
 * A PopupMenuSection's actor is its own box, so a section is a container the
 * rest of the menu machinery already understands - items added to it are laid
 * out inside it rather than in the menu, and hiding its actor hides the whole
 * column.
 *
 * A column used to carry a title of its own with a summary beside it:
 * "Performance   Balanced", "Sensors   80.8 °C". Those read well until the
 * rows under them were open all the time, at which point every title was
 * repeating the first row beneath it and the temperature was on screen four
 * times over. What is left is a plain container; the headings inside it name
 * the groups, and the numbers are stated once each.
 */
class Column {
    constructor(parent) {
        this._section = new PanelSection();
        this._section.actor.add_style_class_name("powertoys-panel");
        parent.addMenuItem(this._section);

        this.menu = this._section;
        this.actor = this._section.actor;
    }

    /*
     * A heading plus the section its rows go in, hidden and shown together.
     *
     * `spaced` sets a wider gap above the heading, for a group that follows
     * one it has nothing to do with. The profile and the processor sit close
     * together because the first writes the second; the brightness under them
     * answers to neither, and at the same gap it read as one more thing the
     * power profile does.
     */
    group(title, options) {
        let heading = headingItem(title);
        if (options && options.spaced)
            heading.actor.add_style_class_name("powertoys-group-spaced");
        this._section.addMenuItem(heading);
        let section = new PopupMenu.PopupMenuSection();
        this._section.addMenuItem(section);
        return {
            heading: heading,
            menu: section,
            setVisible: visible => {
                heading.actor.visible = visible;
                section.actor.visible = visible;
            },
        };
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
    constructor(menu, actions, backlights) {
        this._menu = menu;
        this._actions = actions;
        this._build(backlights || {});
    }

    /*
     * Three columns, with the settings rows below them.
     *
     * One subject each, left to right in the order they answer to each other:
     * what the machine has been told to do, what is plugged into it, and what
     * all of that is doing to the temperature. The profile and the processor
     * share the first because the profile is what sets the processor - they
     * are two levels of one decision, not two subjects.
     *
     * The sliders used to run the full width above all three, on the reasoning
     * that a slider reads as a track rather than as a column. What that cost
     * was a band of menu as wide as three columns holding one control and a
     * rule under it, above a first column that ended well short of the bottom
     * of the other two. They are in that column now, under the settings the
     * profile writes, which is where the space already was.
     *
     * A column is only there while something in it is, so a machine with no
     * profiles and no cpufreq, or a user who has switched the devices off,
     * gets two columns or one rather than a gap where a column would have
     * been. See _syncColumns.
     */
    _build(backlights) {
        /* A section laid out the other way round is a row of columns. */
        this._columns = new PopupMenu.PopupMenuSection();
        this._columns.actor.set_vertical(false);
        this._columns.actor.add_style_class_name("powertoys-columns");
        this._menu.addMenuItem(this._columns);

        this._performanceColumn = new Column(this._columns);
        this._deviceColumn = new Column(this._columns);
        this._sensorColumn = new Column(this._columns);
        this._columnList = [this._performanceColumn, this._deviceColumn, this._sensorColumn];

        this._buildProfileGroup();
        this._buildCpuGroup();
        this._buildBrightness(backlights);
        this._buildDeviceGroup();
        this._buildSensorGroup();

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addSettingsAction(_("System power settings"), "power");
    }

    /*
     * The backlights, at the foot of the first column. Each slider hides
     * itself when there is no such backlight, and the heading goes with the
     * last of them.
     *
     * Under a heading of their own the built in ones are named for what they
     * light rather than for what the slider does: "Screen" and "Keyboard",
     * where they used to be "Brightness" and "Keyboard backlight" and had to
     * carry that word themselves. The monitors keep their own names, which is
     * the only thing telling one from another.
     *
     * The monitors are a list rather than three fixed rows: how many there are
     * is not known when the menu is built, because finding out means spawning
     * ddcutil and waiting for hardware that answers in tenths of a second. The
     * section they live in belongs to them alone, since it is emptied and
     * refilled whenever a monitor is plugged in or unplugged.
     */
    _buildBrightness(backlights) {
        this._backlightSliders = [];
        this._screenBacklightSlider = null;
        this._brightnessGroup = this._performanceColumn.group(_("Brightness"),
                                                              { spaced: true });
        this._brightness = this._brightnessGroup.menu;

        if (backlights.screen)
            this._screenBacklightSlider = this._addBacklight(
                _("Screen"), "display-brightness", backlights.screen);

        this._monitors = backlights.monitor || null;
        let monitorSection = new PopupMenu.PopupMenuSection();
        this._brightness.addMenuItem(monitorSection);
        this._monitorList = new KeyedList.KeyedList(
            monitorSection,
            entry => entry.note
                ? this._createNote(entry.label)
                : new BacklightSlider(entry.label, "display-brightness", entry.control),
            (row, entry) => {
                if (!entry.note) {
                    row.adopt(entry.label, entry.control);
                    row.sync();
                }
            });

        if (backlights.keyboard)
            this._addBacklight(_("Keyboard"), "keyboard-brightness", backlights.keyboard);
    }

    /*
     * Which power profile is in force: the one control in this menu that most
     * visits are for, so it is the first thing in the first column.
     */
    _buildProfileGroup() {
        this._profileGroup = this._performanceColumn.group(_("Power profile"));

        this._profileControl = new SegmentedControl(
            Format.profileLabel, value => this._actions.setProfile(value));
        this._profileGroup.menu.addMenuItem(this._profileControl);

        /* A backend with one profile reports useful status but no choice. The
         * same non-reactive value row used by one-value CPU settings keeps it
         * visible without putting a button or keyboard stop around it. */
        this._profileValueRow = new InfoRow(_("Profile"), "");
        this._profileValueRow.actor.hide();
        this._profileGroup.menu.addMenuItem(this._profileValueRow);

        this._degradedRow = new InfoRow(_("Performance limited"), "");
        this._degradedRow.setWarning(true);
        this._degradedRow.actor.hide();
        this._profileGroup.menu.addMenuItem(this._degradedRow);
    }

    /*
     * What the processor has been told to do. Only that.
     *
     * It used to open with the frequency, the temperature and the scaling
     * driver, which are three readings and not three settings. The
     * temperature was the same number as Tctl under the chip's own name in
     * the sensors, stated twice in one menu; the other two are readings about
     * that same chip and are filed with it now, under its name, where the
     * question "what is this processor doing" is already answered. What is
     * left here is the three things that can be changed.
     *
     * The governor and the energy preference were behind an *Advanced*
     * disclosure, on the reasoning that they are what a profile sets and are
     * rarely worth changing by hand. What that produced was a menu which hid
     * two of the processor's own settings behind a click and gave no hint of
     * what was under it - and a disclosure is a promise that what is inside is
     * different in kind, which these are not. They are two more processor
     * settings. They are shown.
     */
    _buildCpuGroup() {
        this._cpuGroup = this._performanceColumn.group(_("Processor"));
        let menu = this._cpuGroup.menu;

        /* The switch carries its own read-only mode, so unlike the two lists
         * below it needs no second widget: insensitive still shows the state. */
        this._boostSwitch = new PopupMenu.PopupSwitchMenuItem(_("Turbo boost"), false);
        this._boostSwitch.connect("toggled", (item, state) => this._actions.setBoost(state));
        menu.addMenuItem(this._boostSwitch);

        /*
         * The governor and the energy preference, where they are anybody's to
         * set. Under power-profiles-daemon they are not: the daemon writes
         * both from whichever profile is in force and writes them again on the
         * next profile change or mains transition, so the power profile above
         * is the control and these go entirely. They were stated under the
         * processor's name in the sensors for a while, as readings; see
         * _cpuReadingRows for why that came back out.
         *
         * They stay controls where nothing else is writing them: a machine
         * with no profiles at all, or one whose only profile is the ACPI
         * platform profile, which writes firmware and never goes near cpufreq.
         * There the governor is the only way to ask for speed.
         */
        this._governorControl = new ChoiceControl(menu, _("Governor"),
                                                  Format.governorLabel,
                                                  value => this._actions.setGovernor(value));
        this._energyControl = new ChoiceControl(menu, _("Energy preference"),
                                                Format.energyPreferenceLabel,
                                                value => this._actions.setEnergyPreference(value));
    }

    /*
     * Anything with a charge in it, and the one setting that governs how full
     * a battery is allowed to get.
     *
     * Called "Devices" rather than "Batteries and devices" because the second
     * half of that title always covered the first: everything listed here is a
     * device, and on a desktop where the only entry is a headset a heading
     * promising batteries is promising something that is not there.
     */
    _buildDeviceGroup() {
        this._deviceGroup = this._deviceColumn.group(_("Devices"));
        let menu = this._deviceGroup.menu;

        /* The charger goes above the batteries: whether it is plugged in is
         * the first thing anyone opening this on a laptop wants. */
        let lineSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(lineSection);
        this._lineList = new KeyedList.KeyedList(lineSection,
                                       entry => new InfoRow(entry.label, entry.value),
                                       (row, entry) => {
                                           row.setLabel(entry.label);
                                           row.setValue(entry.value);
                                       });

        let deviceSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(deviceSection);
        this._deviceList = new KeyedList.KeyedList(deviceSection,
                                         entry => new DeviceRow(entry.model),
                                         (row, entry) => row.update(entry.model));

        /* An empty group is indistinguishable from a broken one. Say which. */
        this._noDevicesRow = new InfoRow(_("Nothing with a battery is connected"), "");
        this._noDevicesRow.actor.hide();
        menu.addMenuItem(this._noDevicesRow);

        /*
         * The charge limit, whether or not this machine has one today.
         *
         * It used to be built only where the applet had found a battery with a
         * threshold node in its constructor, which made the menu's shape a
         * fact from startup: a dock or a bay battery plugged in afterwards had
         * nowhere to appear. The group empties itself when there is nothing to
         * offer, the same way every other group in this menu hides, and
         * _updateCharge asks the reading rather than the constructor.
         */
        this._chargeLimitControl = new ChoiceControl(
            menu, _("Charge limit"), limit => limit + "%",
            value => this._actions.setChargeLimit(value));

        /*
         * Where the batteries have been set apart by something else there
         * is no one figure to dot, and a group of limits with none of them
         * marked reads as a control that has stopped working. Say what it
         * is instead, and say that choosing one ends it - which is true,
         * because the helper writes every battery that has the node.
         */
        this._chargeStateRow = new NoteRow("");
        this._chargeStateRow.actor.hide();
        menu.addMenuItem(this._chargeStateRow);
    }

    _buildSensorGroup() {
        this._sensorGroup = this._sensorColumn.group(_("Sensors"));

        /*
         * What the machine is running on, first thing under the heading.
         *
         * It was a strip across the whole menu, and it carried the processor
         * temperature and the power draw beside it - both of which are rows
         * further down this very column, so the widest line in the menu was
         * two numbers repeated from underneath it. What is left is the one
         * thing the strip said that nothing else does: which supply the
         * machine is on.
         *
         * It sits inside the group, above the chips, rather than over the
         * heading. Whether the machine is on the mains is of a piece with what
         * that is doing to it, and a line on its own above a heading reads as
         * a heading for the heading.
         */
        this._summary = new InfoRow("", "");
        this._sensorGroup.menu.addMenuItem(this._summary);

        /* Only ever shown when the preferred sensor setting names something
         * this machine does not have. Somebody who typed a name has no other
         * way of finding out it was ignored. */
        this._hintRow = new InfoRow("", "");
        this._hintRow.setWarning(true);
        this._hintRow.actor.hide();
        this._sensorGroup.menu.addMenuItem(this._hintRow);

        /*
         * The rows live in a section of their own, because KeyedList clears
         * what it is given whenever the set of sensors changes - and anything
         * else sharing that menu would be destroyed along with them.
         */
        let listSection = new PopupMenu.PopupMenuSection();
        this._sensorGroup.menu.addMenuItem(listSection);
        this._sensorList = new KeyedList.KeyedList(listSection,
                                         entry => entry.heading
                                             ? this._createHeading(entry.label)
                                             : new InfoRow(entry.label, entry.value),
                                         (row, entry) => {
                                             row.setLabel(entry.label);
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
    syncBacklights(externalDisplayMode) {
        for (let slider of this._backlightSliders)
            slider.sync();
        /* A closed laptop panel still has a working kernel backlight, but it
         * is not a screen the user can see. Its row gives way to the external
         * monitor rows until the lid opens again. */
        if (this._screenBacklightSlider && externalDisplayMode)
            this._screenBacklightSlider.actor.hide();
        this._syncMonitors();

        /* A heading over nothing on a machine with no backlight and no monitor
         * this applet can reach. */
        this._brightnessGroup.setVisible(
            this._backlightSliders.some(slider => slider.actor.visible) ||
            this._monitorList.items.length > 0);

        /*
         * And the column that group is in, which is only otherwise decided by
         * a whole update.
         *
         * A monitor answering the probe while the menu is open shows the group
         * here, but where the profile and the processor are both hidden - no
         * daemon, and the processor switched off - the group it just appeared
         * in belongs to a column that is not on screen, and nothing would put
         * it there until the next poll. Cheap, and settles to the same answer
         * when the update that follows asks again.
         */
        this._syncColumns();
    }

    /*
     * One slider per monitor, rebuilt when the set of them changes.
     *
     * The set is not known when the menu is built and can change while it is
     * open - a monitor is plugged in, one that was asleep starts answering -
     * so this runs on every backlight change and the list only tears itself
     * down when the monitors are really different.
     *
     * A monitor past the tenth gets a line saying so rather than nothing.
     * Silently showing nine of eleven sliders looks exactly like a monitor
     * that does not do DDC/CI, and the two want different things done about
     * them.
     */
    _syncMonitors() {
        if (!this._monitors)
            return;

        let entries = this._monitors.monitors
            .filter(monitor => monitor.available)
            .map(monitor => ({ key: "monitor:" + monitor.id, label: monitor.name,
                               control: monitor }));

        if (this._monitors.hidden > 0)
            entries.push({
                key: "hidden",
                note: true,
                /* The limit rather than the overflow, because the limit is the
                 * part that is worth knowing: it is the same next time. */
                label: _("Only the first %d monitors have a slider")
                    .replace("%d", String(this._monitors.limit)),
            });

        this._monitorList.sync(entries);
    }

    _createHeading(text) {
        let heading = new PopupMenu.PopupMenuItem(text, { reactive: false });
        heading.actor.add_style_class_name("powertoys-subgroup-title");
        heading.label.add_style_class_name("powertoys-subgroup-title-text");
        heading.setLabel = value => heading.label.set_text(value || "");
        return heading;
    }

    /* Drawn at the weight of a reading, "Only the first 10 monitors have a
     * slider" reads as an eleventh monitor called that. See NoteRow. */
    _createNote(text) {
        return new NoteRow(text);
    }

    _addBacklight(label, iconName, control) {
        let slider = new BacklightSlider(label, iconName, control);
        this._brightness.addMenuItem(slider);
        this._backlightSliders.push(slider);
        return slider;
    }

    /*
     * A column is only there while something in it is, and the rule goes
     * between the ones that are left.
     *
     * It is applied here rather than styled because St has no :first-child,
     * and because which column is leftmost is not fixed: a machine with no
     * profiles and no cpufreq leaves the devices at the edge, and a user who
     * has switched those off as well leaves the sensors there.
     *
     * The columns are not made equal. That was tried, by measuring the widest
     * and giving it to the others as a floor, and it cannot be done this way:
     * Clutter caches a preferred size until the next layout pass, so clearing
     * the last floor and measuring again in the same turn reads back the
     * floor rather than the content, and each poll set a floor a little wider
     * than the last. Every column ended up as wide as the widest thing in the
     * menu, which is what the measuring was meant to avoid. A column is
     * allowed its own width now, with a floor from the stylesheet so that a
     * short one does not look starved.
     */
    _syncColumns() {
        this._performanceColumn.actor.visible = this._profileGroup.heading.actor.visible ||
                                                this._cpuGroup.heading.actor.visible ||
                                                this._brightnessGroup.heading.actor.visible;
        this._deviceColumn.actor.visible = this._deviceGroup.heading.actor.visible;
        /* The supply line is inside the sensors group now, so it goes with it:
         * switching the sensors off takes the whole column, that line
         * included. On battery it is still in the panel tooltip, and the
         * battery itself is a row under Devices. */
        this._sensorColumn.actor.visible = this._sensorGroup.heading.actor.visible;

        let visible = this._columnList.filter(column => column.actor.visible);
        visible.forEach((column, index) => {
            if (index === 0)
                column.actor.remove_style_class_name("powertoys-panel-divided");
            else
                column.actor.add_style_class_name("powertoys-panel-divided");
        });
    }

    update(data, options) {
        this.syncBacklights(options.externalDisplayMode);
        this._updateSummary(data, options);
        this._updateProfiles(data, options);
        this._updateDevices(data, options);
        this._updateCpu(data, options);
        this._updateSensors(data, options);
        this._updateCharge(data, options);
        this._syncColumns();
    }

    /*
     * Which supply the machine is on, and nothing that is already elsewhere.
     *
     * This line used to carry the processor temperature and the power draw as
     * well. Both are rows in the column it now sits at the top of - the
     * temperature under the processor's own name, the watts under whichever
     * chips are drawing them - so it was stating two figures a hand's width
     * above the rows they came from, and it was the widest line in the menu
     * for it.
     *
     * On battery the charge and the state stay, because the battery has
     * somewhere else to be only if the devices column is switched on, and
     * "two hours left" is the reason most people open this at all.
     */
    _updateSummary(data, options) {
        if (data.primary) {
            this._summary.setLabel(Format.deviceKindName(data.primary.kind) + " " +
                                   Format.batteryReading(data.primary).text);
            let detail = Format.deviceStateName(data.primary.state);
            let remaining = Device.remainingText(data.primary);
            if (remaining)
                detail += " · " + remaining;
            this._summary.setValue(detail);
        } else {
            this._summary.setLabel(PanelText.powerStatusLabel(data));
            this._summary.setValue("");
        }
    }

    _updateProfiles(data, options) {
        let show = options.showProfiles && data.profile.available && data.profile.list.length > 0;
        /* The filled segment follows what was asked for, not what has arrived:
         * a selection that springs back for a second while the daemon thinks
         * about it reads as the click having missed. The panel gauge and the
         * panel label answer the same question, which is why all three ask it
         * of one function rather than each spelling it out. */
        let active = Reading.shownProfile(data, options);
        let editable = Reading.profileCanChange(data, options.privileged);
        let single = show && data.profile.list.length === 1;
        this._profileGroup.setVisible(show);
        this._profileControl.sync(show && !single ? data.profile.list : [], active, editable);
        this._profileControl.actor.visible = show && !single;
        this._profileValueRow.setValue(single
            ? Format.profileLabel(active || data.profile.list[0]) : "");
        this._profileValueRow.actor.visible = single;

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

        this._deviceGroup.setVisible(options.showDevices);
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
         * An empty group and a broken one look the same, and on a desktop
         * whose bluetooth mouse happens to be switched off this group is
         * empty for a perfectly good reason. Say which it is.
         */
        this._noDevicesRow.actor.visible = lines.length === 0 && devices.length === 0;
    }

    _updateCpu(data, options) {
        let show = options.showCpu && data.cpu.available;
        this._cpuGroup.setVisible(show);
        if (!show)
            return;

        /* While a privileged change is in flight there is a password dialog
         * on screen and a second click can only queue behind it, so the
         * controls say so rather than pretending to be ready. */
        let editable = options.privileged && !options.busy;
        let owned = Reading.profileOwnsGovernor(data);
        this._governorControl.sync(data.cpu.governors, data.cpu.governor, editable, !owned);
        this._energyControl.sync(data.cpu.energyPreferences, data.cpu.energyPreference,
                                 editable, !owned);

        this._boostSwitch.actor.visible = data.cpu.boostSupported;
        if (data.cpu.boostSupported) {
            if (data.cpu.boostEnabled !== null)
                this._boostSwitch.setToggleState(data.cpu.boostEnabled);
            this._boostSwitch.setSensitive(editable);
        }

        /* Under a daemon that owns cpufreq, and on a machine with no turbo
         * switch, this group has nothing left in it to head. */
        if (!this._boostSwitch.actor.visible && !this._governorControl.visible &&
            !this._energyControl.visible)
            this._cpuGroup.setVisible(false);
    }

    _updateSensors(data, options) {
        this._sensorGroup.setVisible(options.showSensors);
        if (!options.showSensors)
            return;

        this._hintRow.actor.visible = data.hintMatched === false;
        if (data.hintMatched === false)
            this._hintRow.setLabel(_("No sensor matches") + " \u201c" + options.sensorHint + "\u201d");

        /* Which readings get a row, what each is called and where the headings
         * fall is lib/sensor-rows.js; what is left here is handing the answer
         * to the list. */
        this._sensorList.sync(SensorRows.rows(data, options));
    }

    /* Under the devices heading, so it is beside the battery it applies to
     * rather than being a submenu of its own. */
    _updateCharge(data, options) {
        /* Whether this machine has a battery whose limit can be written is
         * asked of the reading rather than of what was true when the menu was
         * built: a dock or a bay battery arrives after that, and the applet
         * looks again. An empty list clears the group, which is how it hides. */
        let show = data.chargeLimitAvailable;
        let editable = options.privileged && !options.busy;
        this._chargeLimitControl.sync(show ? CHARGE_LIMITS : [], data.chargeLimit,
                                      editable, show);
        let note = "";
        if (data.chargeLimitState === "divided") {
            note = editable
                ? _("The batteries have different limits; choosing one sets all batteries.")
                : _("The batteries have different charge limits.");
        } else if (data.chargeLimitState === "incomplete") {
            note = editable
                ? _("Some battery limits could not be read; choosing one sets all batteries.")
                : _("Some battery limits could not be read.");
        }
        this._chargeStateRow.setText(note);
        this._chargeStateRow.actor.visible = show && note !== "";
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

        /* Every field teardown may reach exists before the first acquisition.
         * If initialization fails, the constructor never returns an applet for
         * Cinnamon to remove, so it must release what was acquired itself. */
        this._destroyed = false;
        this._panel = null;
        this.settings = null;
        this._helper = null;
        this._sensors = null;
        this._cpu = null;
        this._chargeControl = null;
        this._backlights = {};
        this._bluetooth = null;
        this._profiles = null;
        this._platformProfiles = null;
        this._profileBackend = null;
        this._upower = null;
        this.menuManager = null;
        this.menu = null;
        this._menuPresenter = null;
        this._hotkeyIds = [];
        this._actorSignalIds = [];
        this._iconTheme = null;
        this._iconThemeId = 0;
        this._monitorsId = 0;

        try {
            this._initialize(metadata, orientation, instanceId, backends);
        } catch (error) {
            this._teardown();
            throw error;
        }
    }

    _initialize(metadata, orientation, instanceId, backends) {

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
        this._idleId = 0;
        /* A reading is in flight; another was asked for while it was. */
        this._collecting = false;
        this._collectAgain = false;
        this._scrollTimerId = 0;
        this._pendingScroll = 0;
        /* Why monitors are being looked for, and the timer that does it. Both
         * empty means nobody is looking at the applet; see _watchMonitors. */
        this._probeReasons = new Set();
        this._probeTimerId = 0;
        /* UPower owns the live lid state. False is deliberately conservative
         * until its manager proxy says otherwise. */
        this._lidClosed = false;
        /* Whether this machine has a backlight of its own, as the settings
         * daemon answered it. False until it has; see _onScreenBacklightKnown,
         * which is also where the difference between this and the control's own
         * `available` is set out. */
        this._hasKernelBacklight = false;
        /* A profile asked for and not yet arrived, which the panel and the
         * menu draw until it does - or until it is clear it will not. */
        this._pending = new PendingProfile.PendingProfile((asked, actual) => {
            Log.error("asked for the " + asked + " profile and the machine is still on " +
                      (actual || "none") + "; showing what it reports");
        });
        /* The policy decides whether something is worth saying; where it is
         * said is the applet's, because it is the only part of this that has a
         * tray to say it in. */
        this._alerts = new Alerts.AlertPolicy((urgent, title, body) => {
            if (urgent)
                Main.criticalNotify(title, body);
            else
                Main.notify(title, body);
        });
        /* A hover gets one prefetch so a later menu is ready; only an open
         * menu keeps probing. The tooltip itself names no monitor. */
        this._panel = new PanelPresenter(this, metadata.path + "/icons",
                                         shown => this._watchMonitors("tooltip", shown));
        this._hotkeyIds = [];
        this._normalizingAlertLevels = false;

        this._bindSettings();

        this._helper = this._backends.privilegedHelper(
            [SYSTEM_HELPER, metadata.path + "/" + HELPER],
            path => this._backends.fileExists(path),
            path => this._ensureExecutable(path));

        /* Discovery opens many metadata files and may load pci.ids. The
         * backend keeps its prior complete snapshot while doing that work and
         * asks for a new reading only after the replacement is ready. */
        this._sensors = this._backends.sensors(() => this._scheduleUpdate());
        this._cpu = this._backends.cpuControl(
            (args, onDone) => this._runHelper(args, onDone),
            () => this._scheduleUpdate());
        this._chargeControl = null;
        this._rediscoverChargeControl();

        /*
         * The bag exists before anything is in it, and the screen goes in
         * last.
         *
         * A control can answer from inside its own constructor: lib/backlight.js
         * reports a bus it cannot even reach from its own catch, and calls
         * onReady straight from there. The screen's onReady is
         * _onScreenBacklightKnown, which decides whether to go looking for a
         * monitor and so reaches for this._backlights.monitor - and with the
         * whole bag written as one literal, neither the field nor the monitor
         * existed at that moment. A session bus that throws when it is reached
         * took the applet off the panel altogether with a TypeError in this
         * constructor, on the machines least able to say why.
         *
         * The screen control itself is not in the bag when its own answer
         * arrives either, which is why onReady is handed the control it is
         * about rather than being expected to find it.
         */
        this._backlights = {};
        /*
         * Monitors on a cable have no kernel backlight and have to be talked
         * to over DDC/CI. The control exists from the start so the menu can
         * hold a row for it, but it does not go looking for a monitor until
         * it is told to - see _onScreenBacklightKnown().
         */
        this._backlights.monitor = this._backends.monitorBacklight(
            () => this._onBacklightChanged());
        this._backlights.keyboard = this._backends.backlight(
            Backlight.KEYBOARD,
            () => this._onBacklightChanged(),
            () => this._onBacklightChanged());
        this._backlights.screen = this._backends.backlight(
            Backlight.SCREEN,
            () => this._onScreenBacklightChanged(),
            control => this._onScreenBacklightKnown(control));

        /* Bluetooth devices UPower does not bridge - which on some builds is
         * all of them - reported by BlueZ itself. */
        this._bluetooth = this._backends.bluetoothBatteries(() => this._scheduleUpdate());

        this._profiles = this._backends.profilesClient(() => {
            /* The daemon appearing or vanishing is the only thing that
             * changes which backend answers, and the only thing that says so. */
            this._chooseProfileBackend();
            this._scheduleUpdate();
        });
        this._platformProfiles = this._backends.platformProfileClient(
            (args, onDone) => this._runHelperQuietly(args, onDone));
        this._chooseProfileBackend();
        this._upower = this._backends.upowerMonitor(() => this._onUPowerChanged(),
                                                    () => this._onUPowerChanged());
        /* A stubbed backend can answer inside its own constructor, before the
         * assignment above exists. Read it once after assignment as well. */
        this._syncLidState();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._createMenu(orientation);

        this._actorSignalIds.push(
            this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event)),
            this.actor.connect("button-press-event",
                               (actor, event) => this._onButtonPress(actor, event)));

        /*
         * Which icon names exist is a fact about the current theme, and both
         * caches that hold one of those answers - the device names in Format,
         * the panel's own icon - were only ever dropped on a reload. Someone
         * switching to a theme without the xapp set got blank device rows
         * until they restarted Cinnamon.
         */
        this._iconTheme = Gtk.IconTheme.get_default();
        this._iconThemeId = this._iconTheme.connect("changed", () => this._onIconThemeChanged());

        /* Which screens exist is a fact about the desktop, and it is the only
         * warning there is that the monitors this applet found are no longer
         * the monitors that are there. */
        this._monitorsId = Main.layoutManager.connect("monitors-changed",
                                                      () => this._onMonitorsChanged());

        this._registerHotkeys();
        this._startPolling();
        /* Before the greeting: it is the greeting that marks the install as
         * one that has run before, which is what this reads. */
        this._migratePanelText();
        this._normalizeAlertLevels();
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
            /* Switching it either way has to reach the monitors: on sends the
             * applet looking for one, off lets go of the ones it found, and
             * nothing else would do either until a reload. The sliders are
             * synced directly because this is changed from the settings
             * window, with the menu shut, and _update only draws a menu that
             * is open. */
            monitor: () => {
                this._considerMonitorBacklight();
                this._onBacklightChanged();
                this._update();
            },
            hotkeys: () => this._registerHotkeys(),
            alertLevels: () => this._onAlertLevelsChanged(),
        };

        for (let setting of SETTINGS) {
            let handler = handlers[setting.onChange || "redraw"];
            this.settings.bind(setting.key, setting.property, handler);
        }

        this._reportUnboundSettings();
        this._tempUnitInUse = this.tempUnit;
    }

    _normalizeAlertLevels() {
        let effective = Alerts.criticalBelow(this.criticalBatteryThreshold,
                                             this.lowBatteryThreshold);
        if (effective !== this.criticalBatteryThreshold)
            this.settings.setValue("critical-battery-threshold", effective);
    }

    _onAlertLevelsChanged() {
        if (this._normalizingAlertLevels)
            return;
        this._normalizingAlertLevels = true;
        try {
            this._normalizeAlertLevels();
        } finally {
            this._normalizingAlertLevels = false;
        }
        this._update();
    }

    /*
     * The first run, and only the first.
     *
     * Nobody reads a README before using a panel applet, and there is not
     * much to go on otherwise: on a desktop the applet is an icon with no
     * text beside it. The menu itself shows everything it can do as soon as
     * it is opened, so this says that the menu is worth opening and where the
     * settings are.
     *
     * It also names the wheel and the middle button, because those two are
     * the only things this applet does that leave no trace of themselves
     * anywhere: an icon does not look scrollable, and nobody middle clicks a
     * panel to find out what happens. This notification is the one moment
     * somebody is certain to be reading, so it is where they get said.
     */
    _introduce() {
        if (this.introduced)
            return;

        /*
         * Inside a try because this is the last thing the constructor does
         * and the least important thing the applet does, and because it has
         * been seen to throw.
         *
         * Once, on Cinnamon 6.6.9, this line ended the constructor with
         * "right-hand side of 'in' should be an object, got undefined" and
         * the applet never reached the panel - no icon, and nothing to go on
         * but a stack in the shell log naming a greeting. It has not happened
         * again: called from the same session afterwards, Main.notify does
         * not throw. So the cause is not known and is not claimed here. What
         * is known is that an exception on this line costs somebody the whole
         * applet, and that no first run message is worth that.
         */
        try {
            Main.notify(_("Power Toys"),
                        _("Power profiles, processor settings, batteries and sensors " +
                          "are in this menu. The wheel over the icon changes screen " +
                          "brightness, a middle click toggles the keyboard backlight. " +
                          "Right click to configure those, and to set shortcuts."));
            this.settings.setValue("introduced", true);
        } catch (error) {
            Log.error("could not show the first-run notification: " + error);
        }
    }

    /*
     * The settings daemon has said whether this machine has a backlight of
     * its own. If it has, that is the one to use and nothing needs to go
     * poking at the I2C bus; if it has not, a monitor on a cable is the only
     * screen there is, and DDC/CI is the only way to reach it.
     */
    _onScreenBacklightKnown(control) {
        /*
         * The answer is kept, rather than the control being asked again later.
         *
         * `available` on a BacklightControl is about the last call it made:
         * refresh() lowers it whenever a GetPercentage comes back with an
         * error, and the menu re-asks every backlight each time it opens, so
         * cinnamon-settings-daemon being restarted is enough to make a laptop
         * with a perfectly good backlight say it has none. Read as "does this
         * machine have a backlight of its own" - which is what decides whether
         * to go anywhere near the I2C bus - that answer is wrong, and it is
         * wrong in the expensive direction: redetect() starts a control that
         * was never started, so the applet would begin spawning ddcutil across
         * the buses of a machine that was deliberately kept off them, and grow
         * sliders for whatever answered.
         *
         * This is the one moment the question is honestly answered: the daemon
         * has been asked and has replied. Which control the wheel moves is a
         * different question about the moment, and _brightnessControl still
         * asks `available` for it.
         *
         * Asked of the control that is answering rather than of the field
         * holding it: this can be called from inside that control's own
         * constructor, before there is a field. See where the backlights are
         * built.
         */
        if (control.available)
            this._hasKernelBacklight = true;
        this._considerMonitorBacklight();
        this._onBacklightChanged();
    }

    _onScreenBacklightChanged() {
        let control = this._backlights.screen;
        if (control.available && !this._hasKernelBacklight) {
            this._hasKernelBacklight = true;
            this._considerMonitorBacklight();
        }
        this._onBacklightChanged();
    }

    /* UPower manager properties include both the power source and the laptop
     * lid. Most changes only redraw the reading; a lid transition also changes
     * which brightness backend and which slider belong on screen. */
    _onUPowerChanged() {
        if (this._destroyed)
            return;
        this._syncLidState();
        this._scheduleUpdate();
    }

    _syncLidState() {
        let closed = !!(this._upower && this._upower.lidIsClosed);
        if (closed === this._lidClosed)
            return;
        this._lidClosed = closed;
        this._considerMonitorBacklight();
        this._onBacklightChanged();
    }

    _externalDisplayMode() {
        return this._hasKernelBacklight && this._lidClosed;
    }

    /*
     * Whether to go looking for a monitor on a cable, asked both when the
     * settings daemon answers and whenever the setting is switched.
     *
     * It used to be asked only on the first of those, so somebody who turned
     * *Control external monitor brightness* on got nothing until they
     * reloaded the applet - the one thing a person who has just switched
     * something on will not think to do. start() is guarded against being
     * called twice, so asking again costs nothing when the probe has already
     * happened.
     *
     * Off is the same story the other way round, and had the same hole in it:
     * there was no off path at all, so switching the setting off left the
     * sliders in the menu and the wheel still driving the monitors, against a
     * setting that said not to. The setting's own tooltip offers it as the way
     * to stop the probe, and the first thing somebody who has just switched it
     * off will look at is whether the sliders went.
     */
    _considerMonitorBacklight() {
        if (!this._canProbeMonitors())
            this._backlights.monitor.stop();
        else
            this._backlights.monitor.start();
        /* Both of the answers above can move under a reason that is already
         * held - the daemon answering late, the setting switched with the menu
         * open - and the watch is armed from them. See _considerProbing. */
        this._considerProbing();
    }

    /*
     * A monitor has been plugged in, unplugged or rearranged.
     *
     * The desktop knows this and says so, which is the cheapest moment there
     * is to look again. It is not the only one - see _watchMonitors - because
     * it only fires for a connector changing, and a monitor that was asleep,
     * switched on without a hotplug event or slow to answer produces none.
     */
    _onMonitorsChanged() {
        if (this._destroyed)
            return;
        this._probeMonitors();
    }

    /*
     * Look for monitors while somebody is looking at the applet.
     *
     * The desktop's own signal misses the monitor that was asleep when the
     * applet started, the adapter that answers late, and every switch-on that
     * produces no hotplug event - each of which is a slider that never appears
     * for the rest of the session, on exactly the machines where these sliders
     * are the only brightness control there is.
     *
     * The cost is why this is bounded to the moments the applet is being read
     * rather than put on the poll: a probe spawns ddcutil, talks to every
     * display on the I2C bus and wakes a sleeping monitor. Somebody with the
     * menu open or the pointer resting on the icon is looking at the applet
     * and can be spent on; nobody else is, and the timer does not exist while
     * nobody is.
     *
     * What holds it up is a set of reasons rather than a flag, because the
     * reasons overlap: the tooltip goes away as the menu opens under the
     * pointer, and stopping the probe there only to start it again a moment
     * later is a probe wasted on the same person still looking.
     *
     * The first probe goes out at once rather than a second later. Whatever
     * has just given a reason is being looked at now, and a slider that
     * appears a second after the menu opens is a slider that was not there
     * when it was looked for.
     */
    _watchMonitors(reason, wanted) {
        let alreadyWanted = this._probeReasons.has(reason);
        if (wanted)
            this._probeReasons.add(reason);
        else
            this._probeReasons.delete(reason);

        /* The tooltip contains no monitor data. A single warm-up probe makes
         * a subsequent menu open current without turning an accidental hover
         * into recurring I2C traffic. The open menu is the only reason that
         * owns the recurring timer. */
        if (reason === "tooltip" && wanted && !alreadyWanted &&
            !this._probeReasons.has("menu"))
            this._probeMonitors();
        this._considerProbing();
    }

    /*
     * Arm the timer, or drop it, from what is true now.
     *
     * Two things have to hold for it to exist: somebody is looking, and there
     * is something a look could find. The second was asked inside the tick and
     * not before it, so on every machine with a kernel backlight of its own -
     * which is every laptop, and the common case - each hover and each open
     * menu started a timer whose every tick did nothing at all, against a
     * comment saying the timer does not exist while there is nobody to spend
     * it on.
     *
     * It is asked here rather than only at the two moments a reason arrives
     * because the answer moves under a reason that is already held: the
     * settings daemon can say late that there is a kernel backlight, and the
     * setting can be switched with the menu open. Both of those already reach
     * _considerMonitorBacklight, which asks again on the way out.
     */
    _considerProbing() {
        if (this._destroyed || !this._probeReasons.has("menu") ||
            !this._canProbeMonitors()) {
            this._stopProbingMonitors();
            return;
        }
        if (this._probeTimerId)
            return;

        this._probeMonitors();
        this._probeTimerId = Mainloop.timeout_add_seconds(MONITOR_PROBE_SECONDS, () => {
            this._probeMonitors();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /*
     * Whether looking for a monitor could find one worth having.
     *
     * The setting says whether this is wanted at all. A usable built-in panel
     * keeps DDC off the machine; when UPower says its lid is closed, that panel
     * is no longer the visible screen and the external monitors become the
     * controls worth finding.
     *
     * The second half used to be asked of the screen control's `available`,
     * which is about the moment and about nothing else: it is lowered by any
     * failed GetPercentage. The daemon's answer is remembered instead, at the
     * moment it answers; see _onScreenBacklightKnown.
     */
    _canProbeMonitors() {
        return Backlight.shouldUseMonitorBacklight(
            this.monitorBrightness, this._hasKernelBacklight, this._lidClosed);
    }

    _stopProbingMonitors() {
        if (this._probeTimerId) {
            Mainloop.source_remove(this._probeTimerId);
            this._probeTimerId = 0;
        }
    }

    /*
     * One look for monitors, from wherever the reason came from.
     *
     * A probe that lands while ddcutil is already talking to this machine is
     * dropped by the control itself rather than queued (PT-145c, PT-146), so
     * nothing here has to know how long ddcutil is taking or what else is on
     * the bus.
     */
    _probeMonitors() {
        if (this._canProbeMonitors())
            this._backlights.monitor.redetect();
    }

    /*
     * A backlight moved - a function key, the daemon dimming on idle, the
     * slider itself. Only the sliders need to hear about it: nothing else in
     * the menu or the panel depends on a backlight, and the control already
     * knows its new value, so there is nothing to go and read.
     */
    _onBacklightChanged() {
        if (!this._destroyed && this._menuPresenter)
            this._menuPresenter.syncBacklights(this._externalDisplayMode());
    }

    /*
     * A key that is not in the schema binds without complaint and leaves its
     * property undefined, and undefined reads as "off" at every one of the
     * places that use it. Saying so once, at startup, is the difference
     * between a five minute fix and a puzzling bug report.
     */
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
            /*
             * Opening the menu already refreshes every backlight, but a
             * refresh only re-reads the monitors already known and cannot find
             * one that was not there before - which is why opening the menu
             * did not fix a missing slider. The flag this handler carries is
             * the whole of the menu's part in it: up while it is open, down
             * when it shuts.
             */
            this._watchMonitors("menu", open);
        });

        this._menuPresenter = new MenuPresenter(this.menu, this._menuActions(),
                                               this._backlights);
    }

    /* What the menu is allowed to ask for. Every one of these ends in a write
     * the applet is responsible for, which is why the menu does not do them. */
    _menuActions() {
        return {
            setProfile: name => this._setProfile(name),
            setGovernor: value => {
                if (!this._latest || value !== this._latest.cpu.governor)
                    this._cpu.setGovernor(value);
            },
            setEnergyPreference: value => {
                if (!this._latest || value !== this._latest.cpu.energyPreference)
                    this._cpu.setEnergyPreference(value);
            },
            setBoost: state => {
                if (!this._latest || state !== this._latest.cpu.boostEnabled)
                    this._cpu.setBoost(state);
            },
            /* The control is looked for again while the applet runs, so the
             * one this closure reaches is whichever is there when the click
             * happens - and on a machine with none, there is none. */
            setChargeLimit: value => {
                if (this._chargeControl &&
                    (!this._latest || value !== this._latest.chargeLimit))
                    this._chargeControl.setLimit(value);
            },
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
            pendingProfile: this._pending.value,
            externalDisplayMode: this._externalDisplayMode(),
            busy: this._helper.busy,
        };
    }

    _destroyMenu() {
        if (!this.menu)
            return;
        /* An orientation change throws the menu away wholesale, and a menu
         * that is gone never says it shut. */
        this._watchMonitors("menu", false);
        this.menuManager.removeMenu(this.menu);
        this.menu.destroy();
        this.menu = null;
        this._menuPresenter = null;
    }

    /* ------------------------------------------------------------------ */
    /* data collection                                                     */
    /*                                                                     */
    /* One reading of the whole machine, in two halves: _collect takes it,   */
    /* _assemble makes it. Each backend describes its own part; what is left */
    /* here is putting the parts side by side and answering the two          */
    /* questions that need more than one of them - which sensor the panel    */
    /* shows, and which of several numbers counts as the machine's power     */
    /* draw.                                                                 */
    /* ------------------------------------------------------------------ */

    /* Answers exactly once, with the reading or with null when there is not
     * one. The caller has an in-flight flag riding on that promise. */
    _collect(onDone) {
        let readings = null;
        let sensorsReady = false;
        let cpuReady = false;
        let finish = () => {
            if (!sensorsReady || !cpuReady)
                return;
            /* Teardown destroys the backends after a read has started. A
             * backend still settles its callback so the collection can let
             * go, but there is no machine left to assemble for this applet. */
            if (this._destroyed) {
                onDone(null);
                return;
            }
            let data = null;
            try {
                data = this._assemble(readings);
            } catch (error) {
                Log.error("collection failed: " + error);
            }
            onDone(data);
        };

        this._sensors.readAsync(this._sensorFilter(), answer => {
            readings = answer;
            sensorsReady = true;
            finish();
        });
        this._cpu.sample(() => {
            cpuReady = true;
            finish();
        });
    }

    /*
     * The sensor readings, and everything else that describes the machine,
     * put side by side.
     *
     * The other backends answer from memory. UPower and the profile daemon
     * keep their proxies current; processor and sensor nodes were loaded
     * concurrently off the main loop and arrive here as coherent snapshots.
     */
    _assemble(readings) {
        let upower = this._upower.read();
        /* Anything with a charge that UPower did not mention. */
        let devices = upower.devices.concat(this._bluetooth.missingFrom(upower.devices));

        let temperatures = readings.temperatures.concat(upower.temperatures);
        let powers = readings.powers.concat(upower.powers);
        let power = Reading.pickPower(upower.primary, readings.packageWatts, powers);
        let picked = Reading.pickTemperature(temperatures, this.cpuSensorHint);
        let charge = this._readChargeLimit();

        return {
            upowerAvailable: upower.available,
            devices: devices,
            lines: upower.lines,
            primary: upower.primary,
            onBattery: upower.onBattery,
            temperatures: temperatures,
            fans: readings.fans,
            powers: powers,
            packageWatts: readings.packageWatts,
            cpu: this._cpu.snapshot(),
            profile: this._collectProfile(),
            /* whether this machine has a battery whose limit can be written */
            chargeLimitAvailable: charge.available,
            chargeLimit: charge.limit,
            chargeLimitState: charge.state,
            /* The picker can deliberately choose a GPU, battery or explicitly
             * hinted sensor. Keep its identity beside the value so an alert
             * and the tooltip can say what they are reporting. */
            selectedTemperature: picked.sensor,
            /* whether the user's hint is the reason it came from there -
             * false means they asked for a sensor and it was not found,
             * which is worth saying out loud */
            hintMatched: picked.hintMatched,
            systemWatts: power.watts,
            systemWattsSource: power.source,
        };
    }

    /*
     * Which batteries a charge limit could be written to, looked for again.
     *
     * This was asked once, in the constructor, and its answer decided two
     * things for the whole session: whether the menu was built with a charge
     * limit group in it at all, and which batteries a write reached. A battery
     * that appears afterwards - a dock, a bay battery, a vendor module that
     * loads late - had a threshold node nobody read and no control to write
     * it, while the sensors beside it were being rediscovered every minute by
     * design. The read half was already deliberately live, because the
     * firmware and vendor tools move these; it was the set of batteries that
     * was frozen.
     *
     * Cheap enough to ask where the sensors are asked: a listing of
     * /sys/class/power_supply and a type node per entry. The group in the menu
     * now follows the reading rather than the constructor, so an answer that
     * changes is drawn either way.
     */
    _rediscoverChargeControl() {
        this._chargeControl =
            this._backends.chargeControl((args, onDone) => this._runHelper(args, onDone));
    }

    /*
     * The charge limit, read only when it could be looked at.
     *
     * It is deliberately a live read rather than something remembered: the
     * firmware and other tools change it too. But it appears in one place -
     * the device panel - so with the menu shut there is nobody it could be
     * read for, and it was the last reading in the poll still being taken
     * regardless.
     *
     * Opening the menu re-reads before anything is drawn, so what is on screen
     * is never the value from the last time the menu happened to be open. That
     * is what _adoptChargeLimit is for: the reading the menu is first painted
     * from was assembled with the menu shut, which means it carries no limit at
     * all, and without the re-read the group would draw with nothing marked and
     * fill in a moment later.
     */
    _readChargeLimit() {
        /* Whether there is a control at all is a fact about the machine and is
         * reported whatever the menu is doing; the value is what costs a read
         * and is only worth taking while somebody could be looking at it. */
        let available = !!this._chargeControl;
        if (!available)
            return { available: available, limit: null, state: null, divided: false };
        if (!this.menu || !this.menu.isOpen)
            return { available: available, limit: null, state: null, divided: false };
        return Object.assign({ available: true }, this._chargeControl.reading());
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
        /* "All" describes the visible list, not the background poll. Some of
         * those nodes wake disks or query slow buses, so they are read only
         * while that list can actually be seen. Primary and explicitly
         * hinted sensors still feed the panel, alerts and power selection. */
        let all = this.showSensors && this.showAllSensors &&
                  this.menu && this.menu.isOpen;
        let hint = (this.cpuSensorHint || "").trim();
        return function (sensor) {
            if (all || Sensors.isPrimaryKind(sensor.kind))
                return true;
            return hint !== "" && Sensors.sensorMatches(sensor, hint);
        };
    }

    /*
     * What the machine has, as against what it is doing.
     *
     * The three of these are discovery: which sensors exist, which batteries
     * take a charge limit, and which backend owns the profiles. None of them
     * changes on the cadence a reading does, and each was found once and then
     * kept - so they are asked together, on the slow timer and when the menu
     * opens, which are the two moments the applet already looks at the machine
     * again rather than at its values.
     */
    _rediscover() {
        this._sensors.refresh();
        this._rediscoverChargeControl();
        this._chooseProfileBackend();
    }

    /*
     * Which of the two backends answers, decided here rather than at every
     * place that cares.
     *
     * power-profiles-daemon where it is running, the firmware's own profile
     * where it is not. When there is neither, the daemon client is still the
     * one asked: it answers unavailable, null and an empty list, which is
     * exactly how a machine with no profiles should read.
     *
     * This was wired to one of the two backends' news only - the constructor,
     * and the daemon appearing or vanishing. On a machine with no daemon that
     * callback never fires again, which is exactly the machine the firmware
     * fallback exists for: a vendor module loaded after login, or an applet
     * that came up before the driver settled, left platform_profile there and
     * unread until the applet was reloaded. It is asked with the rest of the
     * discovery now, and costs one exists and two reads while there is no
     * daemon and nothing at all while there is.
     */
    _chooseProfileBackend() {
        if (this._profiles.available)
            this._profileBackend = this._profiles;
        else if (this._platformProfiles.available)
            this._profileBackend = this._platformProfiles;
        else
            this._profileBackend = this._profiles;
    }

    /* One look at whichever backend answers, rather than six. Each of them
     * has its own reason for that mattering: the firmware one opens two files
     * per property, the daemon one unpacks a variant per property. */
    _collectProfile() {
        let state = this._profileBackend.snapshot();
        return {
            available: state.available,
            backend: state.busName,
            active: state.active,
            list: state.profiles,
            degraded: state.degraded,
            holds: state.holds,
        };
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
                this._rediscover();
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
        this._rediscover();
        this._sinceRediscover = 0;
        this._cpu.refresh();
        /*
         * UPower is deliberately not asked to re-poll. Its properties arrive
         * by signal and the proxies are already up to date; Refresh() makes it
         * go and read the hardware, which on a laptop is a real battery poll
         * every time the menu is opened, for values that were already current.
         * Every other battery display on the desktop shows what UPower's own
         * cadence has arrived at, and so does this one.
         */
        for (let name in this._backlights)
            this._backlights[name].refresh(() => this._onBacklightChanged());

        /*
         * The menu is filled from the reading already in hand, and only then
         * is a fresh one asked for.
         *
         * That reading is at most one poll old, and the menu is not updated
         * while it is shut, so without this the menu would be laid out with
         * whatever it last held - nothing at all, the first time - and filled
         * in a millisecond later when the asynchronous read answers. A
         * millisecond is long enough to see: the columns appear, then find
         * their size.
         */
        if (this._latest) {
            this._adoptChargeLimit(this._latest);
            this._menuPresenter.update(this._latest, this._menuOptions());
        }
        this._update();
    }

    /*
     * The charge limit, into a reading that was taken without one.
     *
     * _readChargeLimit only answers while the menu is open, which is the whole
     * of why it is cheap - and the reading the menu is first painted from was
     * assembled while it was shut, so it says there is no limit set. Drawn from
     * that, the group appears with none of its values marked and the dot lands
     * a moment later when the fresh reading arrives, which reads as a control
     * that was broken and then was not.
     *
     * Two file reads, taken here because this is the first moment they can
     * answer: the menu is open by the time open-state-changed is emitted.
     */
    _adoptChargeLimit(data) {
        let charge = this._readChargeLimit();
        data.chargeLimitAvailable = charge.available;
        data.chargeLimit = charge.limit;
        data.chargeLimitState = charge.state;
    }

    /*
     * One turn of the applet: read the machine, then show what was read.
     *
     * The reading is taken asynchronously, so this returns before the answer
     * exists and _present does the showing when it arrives. Two things follow
     * from that. A second update asked for while one is in flight is not
     * dropped and does not start a second read - it is remembered and taken
     * once the first has been shown, so the sequence stays one reading at a
     * time in the order they were asked for. And the applet may be gone by the
     * time the answer comes back, which is what the _destroyed check is for.
     *
     * Every path out of a reading has to come back through `finished`, which
     * is the only thing that lowers the in-flight flag. It used to be lowered
     * in the success callback alone, and a reading that threw - a proxy that
     * went away between two polls is enough - left the flag raised for good:
     * every later poll returned at the guard above, the panel kept whatever it
     * last held, and nothing said why. One transient error stopped the applet
     * for the rest of the session. So a failure is an ordinary answer here,
     * carrying no data, and the flag comes down either way.
     */
    _update() {
        if (this._destroyed)
            return;
        if (this._collecting) {
            this._collectAgain = true;
            return;
        }

        let settled = false;
        let finished = data => {
            if (settled)
                return;
            settled = true;
            this._collecting = false;

            if (this._destroyed)
                return;
            if (data) {
                try {
                    this._present(data);
                } catch (error) {
                    Log.error("could not show the reading: " + error);
                }
            }
            if (this._collectAgain) {
                this._collectAgain = false;
                this._update();
            }
        };

        this._collecting = true;
        try {
            this._collect(finished);
        } catch (error) {
            /* Thrown before the read was even started, so nothing is coming. */
            Log.error("could not start a reading: " + error);
            finished(null);
        }
    }

    _present(data) {
        /* Caught up with what was asked for - or given long enough to and
         * not, in which case the machine is taken at its word. */
        this._pending.settle(data.profile.active);

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

    /* What the three switches say, which is only read where the list is on
     * "Choose below" - and once, on the way past them; see below. */
    _panelSwitches() {
        return { battery: this.panelShowBattery, power: this.panelShowPower,
                 profile: this.panelShowProfile };
    }

    /*
     * The switches, read once into the list that replaced them.
     *
     * Which entry means what they meant is lib/panel-text.js; what is here is
     * the once: a fresh install has nothing to read, because `introduced` is
     * still false, the switches are still at their defaults and the default
     * entry already means what they mean. Run this before the greeting, which
     * is what sets that flag.
     */
    _migratePanelText() {
        if (this.panelTextMigrated)
            return;
        if (this.introduced) {
            let wanted = PanelText.migratedPanelText(this._panelSwitches());
            if (wanted !== this.panelText)
                this.settings.setValue("panel-text", wanted);
        }
        this.settings.setValue("panel-text-migrated", true);
    }

    _panelOptions() {
        let text = PanelText.panelParts(this.panelText, this._panelSwitches());
        return {
            showBattery: text.battery,
            showPower: text.power,
            showProfile: text.profile,
            iconSource: this.panelIconSource,
            tempUnit: this.tempUnit,
            /* a change the machine has not confirmed yet; see shownProfile */
            pendingProfile: this._pending.value,
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
     *
     * It answers whether the call was taken, so a caller that says something
     * about the change - the wheel, the hotkey - can say it only when there
     * was one. Asking again for the profile already in flight is not one.
     */
    _setProfile(name) {
        if (!this._profileState())
            return false;
        let shown = Reading.shownProfile(this._latest,
                                         { pendingProfile: this._pending.value });
        if (name === shown)
            return false;
        let accepted = this._pending.request(name,
            done => this._profileBackend.setProfile(name, done), error => {
                if (error) {
                    /* Cancelling a password dialog is not news; the user did it. */
                    if (error.message !== "cancelled")
                        this._notifyProfileError(name, error);
                }
                this._scheduleUpdate();
            });

        if (!accepted)
            return false;

        /*
         * The menu stays open, and is redrawn now so that the segment fills
         * under the click rather than a poll later.
         *
         * It used to close here, which made a liar of the control: the point
         * of filling the segment that was chosen is that the change can be
         * seen, and it cannot be seen from a menu that has just shut. Nothing
         * else in this menu closes it either, except on the one path that has
         * to - a change going through pkexec closes it so the password dialog
         * can be answered, see _closeMenuForAuthentication - and a profile
         * change is the moment the temperatures and the draw underneath are
         * worth watching. The click dismisses it if that is what was wanted.
         *
         * On a machine without power-profiles-daemon a profile is a platform
         * profile, and that write is one of those pkexec calls: the menu shuts
         * there, because a dialog nobody can answer is worse than a segment
         * nobody can watch fill.
         */
        this._scheduleUpdate();
        return true;
    }

    /*
     * A password dialog cannot be answered from underneath an open menu.
     *
     * An applet menu holds a modal grab for as long as it is up, and the
     * dialog pkexec puts on screen belongs to the polkit agent rather than to
     * us. While the grab is still ours that dialog gets no keyboard and no
     * pointer: the password cannot be typed, Cancel cannot be clicked, and the
     * desktop reads as hung - dimmed, with a dialog on it that answers
     * nothing - until the agent is killed from a terminal or another session.
     *
     * The grab is dropped before the spawn, which is the whole of the fix.
     * Everything else in this menu deliberately stays open while it works -
     * a change that can be watched happening is the point of the controls -
     * so the menu is closed here and nowhere else, only on the way to an
     * authentication, and without the animation so the grab is gone before
     * pkexec is asked for.
     */
    _closeMenuForAuthentication() {
        if (this.menu && this.menu.isOpen)
            this.menu.close(false);
    }

    /*
     * The helper without the notification policy, for a caller that reports
     * the outcome in its own words - a profile that will not switch is not
     * the same news as a governor that will not.
     */
    _runHelperQuietly(args, onDone) {
        if (!this.enablePrivilegedControls) {
            onDone({ applied: false, error: _("Privileged controls are turned off") });
            return;
        }
        this._closeMenuForAuthentication();
        this._helper.run(args, outcome => {
            if (this._destroyed)
                return;
            this._reportHelperWarning(outcome);
            this._cpu.refresh();
            this._update();
            if (!outcome.applied && !outcome.cancelled)
                outcome = Object.assign({}, outcome,
                                        { error: this._helperErrorMessage(outcome) });
            onDone(outcome);
        });
    }

    /* Helper diagnostics describe kernel and filesystem details for the log;
     * they are not UI strings. Codes are deliberately broader and stable, so
     * these messages can be translated without coupling the catalogue to a
     * shell, driver or path. */
    _helperErrorMessage(outcome) {
        switch (outcome && outcome.code) {
        case "invalid-invocation":
        case "invalid-value":
            return _("The requested value is not valid for this control.");
        case "unsupported":
            return _("This control is not supported on this system.");
        case "unavailable":
            return _("This control is currently unavailable.");
        case "write-failed":
            return _("The system refused the requested change.");
        case "change-failed-restored":
            return _("The change failed; the previous settings were restored.");
        case "rollback-failed":
            return _("The change failed and some previous settings could not be restored.");
        case "helper-not-found":
            return _("The privileged helper could not be found.");
        case "stale-system-helper":
            return _("The installed privileged helper is outdated. Re-run the policy installation.");
        case "helper-incompatible":
            return _("The privileged helper is incompatible with this applet version.");
        default:
            return _("The change could not be applied.");
        }
    }

    _reportHelperWarning(outcome) {
        if (!outcome || outcome.warningCode !== "stale-system-helper")
            return;
        Main.notifyError(
            _("Power Toys"),
            _("The installed privileged helper is outdated. Re-run the policy installation."));
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
     * A profile block the applet is currently allowed to change. The daemon
     * is unprivileged; the ACPI fallback follows the privileged-control
     * setting, so wheel, middle click and hotkey stop at the same gate as the
     * menu segment.
     */
    _profileState() {
        let state = this._latest ? this._latest.profile : null;
        if (!state || !state.available || state.list.length === 0)
            return null;
        if (!Reading.profileCanChange(this._latest, this.enablePrivilegedControls))
            return null;
        return state;
    }

    /*
     * One step along that list, from the profile that has been asked for
     * rather than from the one the machine has got round to.
     *
     * Those are the same value except while a change is in flight, and that
     * window is not always short. Under power-profiles-daemon it is a D-Bus
     * round trip; on the ACPI platform profile the write goes through a
     * password dialog and stays pending for as long as that is on screen.
     * Stepping from the old value there computed the same target again,
     * _setProfile dropped it as a duplicate, and the wheel and the hotkey did
     * nothing at all for the whole of it - while the hotkey went on announcing
     * a change that was not happening, because it announced whether or not the
     * call had been taken.
     *
     * "The profile that has been asked for" is the same question the panel
     * gauge, the panel label and the filled segment all ask, so it is asked of
     * the same function. _profileState has already established that there is a
     * reading to ask it about.
     */
    _stepProfile(step, wrap, announce) {
        let state = this._profileState();
        if (!state)
            return false;

        let from = Reading.shownProfile(this._latest, { pendingProfile: this._pending.value });
        let name = Profiles.nextProfile(state.list, from, step, wrap);
        if (!name)
            return false;

        /* Announced only where the call was taken, which is the whole of what
         * the return value above is for. */
        if (!this._setProfile(name))
            return false;
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
        /* Answered rather than dropped, in the same words _runHelperQuietly
         * uses for the same condition. lib/backlight.js and lib/ddc.js pay for
         * the same guarantee on the other side of the applet: a caller that
         * waits on a call which never answers waits for ever, and "nobody
         * waits on this one today" is a fact about today's callers rather than
         * about this method. */
        if (!this.enablePrivilegedControls) {
            if (onDone)
                onDone({ applied: false, error: _("Privileged controls are turned off") });
            return;
        }

        /* So the menu shows the change as in flight straight away rather
         * than when the helper answers. */
        this._scheduleUpdate();

        this._closeMenuForAuthentication();

        this._helper.run(args, outcome => {
            if (this._destroyed)
                return;

            this._reportHelperWarning(outcome);
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
                let changed = Reading.describeChange(args);
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
                                 this._helperErrorMessage(outcome));
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
        let amount = scrollAmount(event);
        if (amount === 0)
            return Clutter.EVENT_PROPAGATE;

        /*
         * Brightness, which is what the applet this one replaces does with
         * the wheel. The notch is the control's own, so on a kernel backlight
         * this moves by the same amount the brightness keys do.
         */
        if (this.scrollAction === "brightness") {
            if (!this._brightnessControl())
                return Clutter.EVENT_PROPAGATE;
            this._gatherScroll(amount, notches => this._stepBrightness(notches));
            return Clutter.EVENT_STOP;
        }

        if (this.scrollAction !== "profile" || !this._profileState())
            return Clutter.EVENT_PROPAGATE;

        /* Announced, because the panel is not necessarily showing the profile
         * and otherwise nothing would say it had changed. */
        this._gatherScroll(amount, notches => this._stepProfile(notches, false, true));
        return Clutter.EVENT_STOP;
    }

    /*
     * The wheel counts, and the count is applied once it settles.
     *
     * One flick of a finger sends several clicks. For the power profile each
     * used to be its own D-Bus write, so a flick meant the daemon switching
     * profiles two or three times in a few tens of milliseconds, and that is
     * why this gathering exists.
     *
     * The brightness did not gather, and needed it more. On a kernel backlight
     * the daemon queues the steps and nothing is lost; on a monitor over
     * DDC/CI each step reads a percentage that has not moved yet and a second
     * write while the first is in flight is refused, so a five-notch flick
     * moved one notch and the other four went nowhere. Brightness is the
     * default action, so that was the common path.
     *
     * Long enough to gather a flick, short enough that the change still feels
     * immediate.
     */
    _gatherScroll(step, apply) {
        this._pendingScroll += step;
        this._cancelPendingScroll();
        this._scrollTimerId = Mainloop.timeout_add(SCROLL_SETTLE_MS, () => {
            this._scrollTimerId = 0;
            let gathered = settledScrollSteps(this._pendingScroll);
            this._pendingScroll = 0;
            if (gathered !== 0)
                apply(gathered);
            return GLib.SOURCE_REMOVE;
        });
    }

    /*
     * A gathered flick, on whichever screen this machine has.
     *
     * Resolved when the flick settles rather than when it started: a monitor
     * can be unplugged, or a probe can finish, in the quarter second between.
     */
    _stepBrightness(notches) {
        let control = this._brightnessControl();
        if (control)
            control.stepBy(notches, () => this._onBacklightChanged());
    }

    /* Whichever screen this machine actually has: its own visible panel, or a
     * monitor on a cable. A closed panel can still report a working kernel
     * backlight, so topology takes precedence over availability here. */
    _brightnessControl() {
        return Backlight.visibleBacklightControl(
            this._backlights.screen, this._backlights.monitor,
            this._externalDisplayMode());
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
            this._registerHotkey(name, this.cycleProfileHotkey, () => this._cycleProfile());
        }
        if (this.toggleMenuHotkey) {
            let name = UUID + "-toggle-menu-" + this.instanceId;
            this._registerHotkey(name, this.toggleMenuHotkey, () => this.menu.toggle());
        }
    }

    _registerHotkey(name, accelerator, action) {
        if (Main.keybindingManager.addHotKey(name, accelerator, action)) {
            this._hotkeyIds.push(name);
            return;
        }
        Main.notifyError(_("Power Toys"),
                         _("Shortcut is already in use") + ": " + accelerator);
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

    _onIconThemeChanged() {
        if (this._destroyed)
            return;
        Format.forgetIcons();
        this._panel.invalidateIcon();
        this._update();
    }

    on_applet_removed_from_panel() {
        this._teardown();
    }

    _teardown() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        /* One failed release must not strand everything acquired before it. */
        let release = (name, action) => {
            try {
                action();
            } catch (error) {
                Log.error("could not release " + name + ": " + error);
            }
        };
        let destroy = (field, name) => {
            let resource = this[field];
            this[field] = null;
            if (resource && typeof resource.destroy === "function")
                release(name, () => resource.destroy());
        };

        release("poll timer", () => this._stopPolling());
        release("monitor timer", () => this._stopProbingMonitors());
        release("scroll timer", () => this._cancelPendingScroll());
        if (this._idleId) {
            let id = this._idleId;
            this._idleId = 0;
            release("update callback", () => Mainloop.source_remove(id));
        }
        release("hotkeys", () => this._removeHotkeys());

        for (let id of this._actorSignalIds)
            release("applet signal", () => this.actor.disconnect(id));
        this._actorSignalIds = [];
        if (this._iconThemeId) {
            let id = this._iconThemeId;
            this._iconThemeId = 0;
            release("icon theme signal", () => this._iconTheme.disconnect(id));
        }
        if (this._monitorsId) {
            let id = this._monitorsId;
            this._monitorsId = 0;
            release("monitor signal", () => Main.layoutManager.disconnect(id));
        }
        release("menu", () => this._destroyMenu());

        destroy("_upower", "UPower monitor");
        destroy("_platformProfiles", "platform profile backend");
        destroy("_profiles", "profile backend");
        this._profileBackend = null;
        destroy("_bluetooth", "Bluetooth backend");
        let backlights = this._backlights;
        this._backlights = {};
        for (let name in backlights) {
            let control = backlights[name];
            if (control && typeof control.destroy === "function")
                release(name + " backlight", () => control.destroy());
        }
        destroy("_cpu", "CPU backend");
        destroy("_sensors", "sensor backend");
        /* Before settings and presentation: no queued privileged job may put
         * a password dialog on screen after its owner has gone. */
        destroy("_helper", "privileged helper");

        let settings = this.settings;
        this.settings = null;
        if (settings)
            release("settings", () => settings.finalize());
        destroy("_panel", "panel presenter");
    }
}

/* Cinnamon calls this with four arguments; the fifth is for the tests. */
function main(metadata, orientation, panelHeight, instanceId, backends) {
    return new PowerToysApplet(metadata, orientation, panelHeight, instanceId, backends);
}
