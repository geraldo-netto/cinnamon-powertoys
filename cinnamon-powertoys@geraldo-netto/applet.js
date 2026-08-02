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
const Cpu = require("./lib/cpu.js");
const Ddc = require("./lib/ddc.js");
const Device = require("./lib/device.js");
const IO = require("./lib/io.js");
const Log = require("./lib/log.js");
const PendingProfile = require("./lib/pending-profile.js");
const PowerSupply = require("./lib/power-supply.js");
const Privileged = require("./lib/privileged.js");
const Sensors = require("./lib/sensors.js");
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
 * How long the wheel has to stop for before a profile change is applied.
 *
 * One flick of a finger sends several clicks, and each one used to be its own
 * D-Bus write, so a flick meant the daemon switching profiles two or three
 * times in a few tens of milliseconds. Long enough to gather a flick, short
 * enough that the change still feels immediate.
 */
const SCROLL_SETTLE_MS = 250;

/* How many accessories the tooltip names before it starts counting them
 * instead. Three, plus the machine's own four or five lines, is about as much
 * as a tooltip is read in one glance. */
const TOOLTIP_PERIPHERALS = 3;

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
    { key: "low-battery-threshold", property: "lowBatteryThreshold" },
    { key: "critical-battery-threshold", property: "criticalBatteryThreshold" },
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

        /*
         * The tooltip is composed when it is about to be shown, not when the
         * reading arrives.
         *
         * It is six lines of formatted text and it is the whole of what the
         * panel costs per poll - and it can only be read with the pointer
         * resting on the applet, which is a fraction of the time the applet
         * exists. Cinnamon calls show() on the tooltip after its own delay,
         * whatever brought the pointer there, so that is the moment to write
         * it: no guessing from enter events, and nothing stale, because a
         * tooltip already on screen is rewritten by the poll below.
         */
        this._reading = null;
        this._readingOptions = null;
        if (tooltip) {
            let show = tooltip.show.bind(tooltip);
            tooltip.show = () => {
                this._writeTooltip();
                show();
            };
        }
    }

    update(data, options) {
        let profile = Reading.shownProfile(data, options);
        let source = this._iconSource(data, options.iconSource, profile);
        this._applet.set_applet_label(this._labelText(data, options, source, profile));
        this._updateIcon(data, source, profile);

        this._reading = data;
        this._readingOptions = options;
        let tooltip = this._applet._applet_tooltip;
        if (tooltip && tooltip.visible)
            this._writeTooltip();
    }

    _writeTooltip() {
        if (this._reading)
            this._applet.set_applet_tooltip(this._tooltipText(this._reading,
                                                              this._readingOptions));
    }

    /* "auto" settled: the battery if there is one, otherwise the profile if
     * there is one. The label needs to know as well as the icon does. */
    _iconSource(data, wanted, profile) {
        let source = wanted || "auto";
        if (source !== "auto")
            return source;
        return data.primary ? "battery" : (profile ? "profile" : "static");
    }

    /* The icon actor is rebuilt from scratch by a panel resize or an
     * orientation change, so the cache has to be dropped with it. */
    invalidateIcon() {
        this._iconKey = null;
    }

    /*
     * The text beside the icon.
     *
     * What may be in it is a charge, a draw and a profile, and the rule for
     * that is one rule rather than a list: a number that moves every few
     * seconds in the corner of the eye is the one thing on a panel that will
     * not be ignored, and none of these is worth that. Nobody acts on 61
     * degrees rather than 59, and nobody acts on 4.30 GHz rather than 4.28.
     *
     * The temperature was kept out on exactly that reasoning while the
     * frequency was offered beside it, which was two rules where the machine
     * only has one kind of number. The frequency has gone the same way. Both
     * are still in the menu, under the processor's own name, where they are
     * looked at on purpose - and the temperature is in the tooltip, which is
     * read by choosing to hover.
     *
     * A charge and a draw move slowly and mean something at a glance: how long
     * is left, and whether the machine is idling or working. The profile does
     * not move at all unless somebody moves it.
     */
    _labelText(data, options, source, profile) {
        let parts = [];
        if (options.showBattery && data.primary && data.primary.percentage !== null)
            parts.push(Format.percent(data.primary.percentage));
        if (options.showPower && data.systemWatts !== null)
            parts.push(Reading.panelPowerText(data));
        if (options.showProfile && this._profileNeedsSpelling(data, source, profile))
            parts.push(Format.profileLabel(profile));
        /* Four figures about four different things, joined by a space, read as
         * one string: "97% 12 W 4.30 GHz Balanced". The dot is what says where
         * each of them ends, and it is the one the menu's own summary line
         * uses for the same job. */
        return parts.join(" · ");
    }

    /*
     * Whether the active profile still needs saying in words.
     *
     * On a desktop there is no battery, so the icon settles on the profile
     * gauge - and "Balanced" printed beside the balanced gauge is one fact
     * taking two pieces of the panel. Where two of the machine's own profiles
     * draw the same gauge, though, the word is the only thing telling them
     * apart, and it stays.
     */
    _profileNeedsSpelling(data, source, profile) {
        if (!profile)
            return false;
        if (source !== "profile")
            return true;
        return !Format.profileIconIsUnambiguous(profile, data.profile.list);
    }

    _updateIcon(data, source, profile) {
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

        let profile = Reading.shownProfile(data, options);
        if (profile)
            lines.push(_("Profile") + ": " + Format.profileLabel(profile));
        if (data.cpu.governor)
            lines.push(_("Governor") + ": " + Format.governorLabel(data.cpu.governor));
        if (data.cpuTemperature !== null)
            lines.push(_("Temperature") + ": " +
                       Format.temperature(data.cpuTemperature, options.tempUnit, 1));
        if (data.systemWatts !== null)
            lines.push(_("Power draw") + ": " + Reading.powerText(data));

        /*
         * The accessories, after a blank line and never more than a few.
         *
         * This was one line per connected thing with a charge in it, with
         * nothing between them and the machine's own lines. A desk with a
         * mouse, a keyboard, a headset and two controllers made an eleven line
         * tooltip, which is not read at all: past about seven lines a list
         * stops being something anybody takes in at a glance, and a tooltip
         * only exists for the glance.
         *
         * The emptiest are the ones worth knowing about, so they are the ones
         * that fit, and the rest are counted rather than dropped silently -
         * the menu lists every one of them under Devices.
         */
        let peripherals = data.devices
            .filter(device => !device.powerSupply && device.percentage !== null)
            .slice()
            .sort((first, second) => first.percentage - second.percentage);

        if (peripherals.length > 0 && lines.length > 0)
            lines.push("");
        for (let device of peripherals.slice(0, TOOLTIP_PERIPHERALS))
            lines.push(Format.deviceTitle(device) + ": " + Format.percent(device.percentage));
        if (peripherals.length > TOOLTIP_PERIPHERALS) {
            lines.push(_("and %d more")
                .replace("%d", String(peripherals.length - TOOLTIP_PERIPHERALS)));
        }

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

    /*
     * The set of keys, as one string that cannot be forged.
     *
     * Joining the keys with a separator is only safe while no key contains
     * one, and these keys are device paths, sensor ids and profile names -
     * none of which promises that. Counting each key's length in front of it
     * means no two different sets can produce the same string, whatever is in
     * them, so a set that has really changed can never read as unchanged and
     * leave the rows as they were.
     */
    _signature(entries) {
        return entries.map(entry => String(entry.key).length + ":" + entry.key).join("");
    }

    sync(entries) {
        let key = this._signature(entries);
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
        this.addActor(this._label, { span: -1, expand: true });
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
        this.setShowDot(selected);
        this.connect("activate", () => onActivate(value));
    }

    setSelected(selected) {
        this.setShowDot(selected);
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
        this._list = new KeyedList(
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

/*
 * The power profile as one row of buttons with the active one filled.
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

    sync(values, active) {
        if (values.join("\u0000") !== this._values.join("\u0000")) {
            this._values = values.slice();
            for (let child of this._box.get_children())
                child.destroy();
            this._buttons = new Map();
            for (let value of values) {
                let button = new St.Button({ label: this._labelFunction(value),
                                             style_class: "powertoys-segment",
                                             can_focus: true });
                button.connect("clicked", () => this._onActivate(value));
                this._box.add(button, { expand: true, x_fill: true });
                this._buttons.set(value, button);
            }
        }

        this._active = active;
        for (let [value, button] of this._buttons) {
            if (value === active)
                button.add_style_class_name("powertoys-segment-active");
            else
                button.remove_style_class_name("powertoys-segment-active");
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
        if (step === 0 || this._values.length === 0)
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
        let percentage = this._control.percentage;
        this._reading.set_text(percentage === null ? "" : percentage + "%");
        this.tooltip.set_text(percentage === null ? this._name
                                                  : this._name + ": " + percentage + "%");
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
    constructor(menu, actions, capabilities, backlights) {
        this._menu = menu;
        this._actions = actions;
        this._build(capabilities || {}, backlights || {});
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
    _build(capabilities, backlights) {
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
        this._buildDeviceGroup(capabilities);
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
        this._brightnessGroup = this._performanceColumn.group(_("Brightness"),
                                                              { spaced: true });
        this._brightness = this._brightnessGroup.menu;

        if (backlights.screen)
            this._addBacklight(_("Screen"), "display-brightness", backlights.screen);

        this._monitors = backlights.monitor || null;
        let monitorSection = new PopupMenu.PopupMenuSection();
        this._brightness.addMenuItem(monitorSection);
        this._monitorList = new KeyedList(
            monitorSection,
            entry => entry.note
                ? this._createNote(entry.label)
                : new BacklightSlider(entry.label, "display-brightness", entry.control),
            (row, entry) => {
                if (!entry.note)
                    row.sync();
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
         * is the control and these are its result. They are hidden there and
         * stated under the processor's name in the sensors, with the frequency
         * and the scaling driver, which is what they are - a reading of what
         * the machine was told.
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
    _buildDeviceGroup(capabilities) {
        this._deviceGroup = this._deviceColumn.group(_("Devices"));
        let menu = this._deviceGroup.menu;

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

        /* An empty group is indistinguishable from a broken one. Say which. */
        this._noDevicesRow = new InfoRow(_("Nothing with a battery is connected"), "");
        this._noDevicesRow.actor.hide();
        menu.addMenuItem(this._noDevicesRow);

        if (capabilities.chargeLimit) {
            let chargeSection = new PopupMenu.PopupMenuSection();
            menu.addMenuItem(chargeSection);
            this._chargeGroup = new SelectorGroup(chargeSection, limit => limit + "%",
                                                  value => this._actions.setChargeLimit(value),
                                                  _("Charge limit"));

            /*
             * Where the batteries have been set apart by something else there
             * is no one figure to dot, and a group of limits with none of them
             * marked reads as a control that has stopped working. Say what it
             * is instead, and say that choosing one ends it - which is true,
             * because the helper writes every battery that has the node.
             */
            this._chargeDividedRow = new NoteRow(
                _("The batteries are set to different limits; choosing one sets both"));
            this._chargeDividedRow.actor.hide();
            menu.addMenuItem(this._chargeDividedRow);
        }
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
        this._syncMonitors();

        /* A heading over nothing on a machine with no backlight and no monitor
         * this applet can reach. */
        this._brightnessGroup.setVisible(
            this._backlightSliders.some(slider => slider.actor.visible) ||
            this._monitorList.items.length > 0);
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
                    .replace("%d", String(Ddc.MAX_DISPLAYS)),
            });

        this._monitorList.sync(entries);
    }

    _createHeading(text) {
        let heading = new PopupMenu.PopupMenuItem(text, { reactive: false });
        heading.actor.add_style_class_name("powertoys-subgroup-title");
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
        this.syncBacklights();
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
                                   Format.percent(data.primary.percentage));
            let detail = Format.deviceStateName(data.primary.state);
            let remaining = Device.remainingText(data.primary);
            if (remaining)
                detail += " · " + remaining;
            this._summary.setValue(detail);
        } else {
            this._summary.setLabel(_("On AC power"));
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
        this._profileGroup.setVisible(show);
        this._profileControl.sync(show ? data.profile.list : [], active);

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

    /*
     * A menu key unique across the three lists. Ids are unique within one of
     * them but not between them: a battery that reports both a temperature
     * and a draw carries the same UPower path in each, and what tells the two
     * readings apart is what they measure.
     */
    _entryKey(reading) {
        return reading.measure + ":" + reading.id;
    }

    /*
     * A reading as a row.
     *
     * The label is the short one - "Edge", not "amdgpu edge (03:00.0)" -
     * because the heading above the row already says which chip it came off.
     * The long name is kept as a fallback for anything that arrived without a
     * group, and for a machine whose libraries predate the short one.
     */
    _rowLabel(reading) {
        return reading.shortLabel || reading.label;
    }

    /* A temperature is worth flagging as it closes on the chip's own limit. */
    _temperatureEntry(sensor, options) {
        return {
            key: this._entryKey(sensor),
            kind: sensor.kind,
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            measure: sensor.measure,
            label: this._rowLabel(sensor),
            value: Format.temperature(sensor.celsius, options.tempUnit, 1),
            warning: sensor.critical !== null && sensor.celsius >= sensor.critical - 5,
        };
    }

    _fanEntry(fan) {
        return { key: this._entryKey(fan), kind: fan.kind, measure: fan.measure,
                 group: fan.group, groupLabel: fan.groupLabel,
                 label: this._rowLabel(fan), value: Format.rpm(fan.rpm), warning: false };
    }

    _powerEntry(meter) {
        return { key: this._entryKey(meter), kind: meter.kind, measure: meter.measure,
                 group: meter.group, groupLabel: meter.groupLabel,
                 label: this._rowLabel(meter), value: Format.watts(meter.watts),
                 warning: false };
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
     * A heading wherever the chip changes.
     *
     * With every sensor shown this list is nineteen rows on the machine it was
     * written on, and nineteen undifferentiated rows is a wall. Headed groups
     * of two to seven are a list.
     *
     * The heading used to be the kind - "Processor", "Graphics" - which was a
     * wall of its own on a machine with two graphics cards: one heading over
     * seven rows, of which two belonged to a different card and said so only
     * in a PCI address at the end of each row. It is the chip itself now, by
     * name, so the address is gone from the rows and the two cards are two
     * blocks.
     */
    _withHeadings(entries, leadIn) {
        let out = [];
        let group = null;
        let placed = !leadIn || leadIn.rows.length === 0;

        for (let entry of entries) {
            if (entry.group !== group) {
                group = entry.group;
                out.push({ key: "heading:" + group, heading: true,
                           label: entry.groupLabel || Sensors.kindLabel(entry.kind) });
                if (!placed && group === leadIn.group) {
                    for (let row of leadIn.rows)
                        out.push(row);
                    placed = true;
                }
            }
            out.push(entry);
        }

        /* The chip the lead-in belongs to reported nothing readable, so it has
         * no group of its own here. It still has a name and the rows still say
         * something, so they get a heading of their own at the front. */
        if (!placed) {
            out = [{ key: "heading:" + leadIn.group, heading: true, label: leadIn.groupLabel }]
                .concat(leadIn.rows, out);
        }
        return out;
    }

    /*
     * What the processor says about itself, filed with the readings off the
     * same chip.
     *
     * The frequency and the scaling driver were rows in the Processor group,
     * where they sat above the governor and the boost switch as though they
     * were settings. They are not: they are what the chip is doing and what is
     * doing it, which is the same kind of thing as its temperature. So they go
     * under the chip's own name, ahead of its temperatures, and the Processor
     * group is left holding only what can be changed.
     *
     * They attach to whichever sensor group came off the processor. Where the
     * machine reports no processor temperature at all there is no such group,
     * and the name from /proc/cpuinfo heads one for them.
     */
    _cpuReadingRows(data) {
        if (!data.cpu.available)
            return null;

        let host = data.temperatures.find(sensor => sensor.kind === "cpu" && sensor.group);
        let rows = [];

        let frequency = Format.frequency(data.cpu.averageFrequency);
        if (data.cpu.maxFrequency)
            frequency += " / " + Format.frequency(data.cpu.maxFrequency);
        if (frequency)
            rows.push({ key: "cpu:frequency", label: _("Frequency"),
                        value: frequency, warning: false });

        let driver = Format.driverLabel(data.cpu.driver, data.cpu.amdPstateStatus);
        if (data.cpu.driver)
            rows.push({ key: "cpu:driver", label: _("Scaling driver"),
                        value: driver, warning: false });

        /* Where the power profile writes these, they are not settings this
         * menu offers - they are what it was told, which is a reading. Where
         * they are still controls they are in the Processor group, and saying
         * them here as well would be the same word twice. */
        if (Reading.profileOwnsGovernor(data)) {
            if (data.cpu.governor)
                rows.push({ key: "cpu:governor", label: _("Governor"),
                            value: Format.governorLabel(data.cpu.governor), warning: false });
            if (data.cpu.energyPreference)
                rows.push({ key: "cpu:energy", label: _("Energy preference"),
                            value: Format.energyPreferenceLabel(data.cpu.energyPreference),
                            warning: false });
        }

        return {
            group: host ? host.group : "cpu:processor",
            groupLabel: host ? host.groupLabel : (data.cpu.model || Sensors.kindLabel("cpu")),
            rows: rows,
        };
    }

    _updateSensors(data, options) {
        this._sensorGroup.setVisible(options.showSensors);
        if (!options.showSensors)
            return;

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

        let leadIn = this._cpuReadingRows(data);

        if (entries.length === 0 && (!leadIn || leadIn.rows.length === 0)) {
            this._sensorList.sync([{ key: "empty", label: _("No sensors found"),
                                     value: "", warning: false }]);
            return;
        }

        entries.sort(Sensors.bySensorOrder);
        this._sensorList.sync(this._withHeadings(entries, leadIn));
    }

    /* Under the devices heading, so it is beside the battery it applies to
     * rather than being a submenu of its own. */
    _updateCharge(data, options) {
        if (!this._chargeGroup)
            return;
        this._chargeGroup.sync(options.privileged && !options.busy ? CHARGE_LIMITS : [],
                               data.chargeLimit);
        this._chargeDividedRow.actor.visible = data.chargeLimitDivided === true;
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
        this._idleId = 0;
        /* A reading is in flight; another was asked for while it was. */
        this._collecting = false;
        this._collectAgain = false;
        this._scrollTimerId = 0;
        this._pendingScroll = 0;
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
            () => this._onBacklightChanged());

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
        this._upower = this._backends.upowerMonitor(() => this._scheduleUpdate(),
                                                    () => this._scheduleUpdate());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._createMenu(orientation);

        this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event));
        this.actor.connect("button-press-event", (actor, event) => this._onButtonPress(actor, event));

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
        };

        for (let setting of SETTINGS) {
            let handler = handlers[setting.onChange || "redraw"];
            this.settings.bind(setting.key, setting.property, handler);
        }

        this._reportUnboundSettings();
        this._tempUnitInUse = this.tempUnit;
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
        this.settings.setValue("introduced", true);

        /*
         * Inside a try because this is the last thing the constructor does
         * and the least important thing the applet does, and because it has
         * been seen to throw.
         *
         * Once, on Cinnamon 6.6.9, this line ended the constructor with
         * "right-hand side of 'in' should be an object, got undefined" and
         * the applet never reached the panel - no icon, and nothing to go on
         * but a stack in the shell log naming a greeting. It has not happened
         * again: called from the same session afterwards, neither Main.notify
         * nor the setValue above it throws. So the cause is not known and is
         * not claimed here. What is known is that an exception on this line
         * costs somebody the whole applet, and that no first run message is
         * worth that.
         */
        try {
            Main.notify(_("Power Toys"),
                        _("Power profiles, processor settings, batteries and sensors " +
                          "are in this menu. The wheel over the icon changes screen " +
                          "brightness, a middle click toggles the keyboard backlight. " +
                          "Right click to configure those, and to set shortcuts."));
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
    _onScreenBacklightKnown() {
        this._considerMonitorBacklight();
        this._onBacklightChanged();
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
        if (!this.monitorBrightness) {
            this._backlights.monitor.stop();
            return;
        }
        if (!this._backlights.screen.available)
            this._backlights.monitor.start();
    }

    /*
     * A monitor has been plugged in, unplugged or rearranged.
     *
     * The desktop knows this exactly once and says so, which is the only cheap
     * moment there is to look again: a DDC/CI probe talks to every display on
     * the bus and wakes a sleeping one, so it is not something to do on a
     * timer. Anything the settings daemon can drive has a kernel backlight and
     * is not this applet's to find, hence the same guard as the first probe.
     */
    _onMonitorsChanged() {
        if (this._destroyed)
            return;
        if (this.monitorBrightness && !this._backlights.screen.available)
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
            this._menuPresenter.syncBacklights();
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
        });

        this._menuPresenter = new MenuPresenter(this.menu, this._menuActions(),
                                               { chargeLimit: !!this._chargeControl },
                                               this._backlights);
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
        this._sensors.readAsync(this._sensorFilter(), readings => {
            let data = null;
            try {
                data = this._assemble(readings);
            } catch (error) {
                Log.error("collection failed: " + error);
            }
            onDone(data);
        });
    }

    /*
     * The sensor readings, and everything else that describes the machine,
     * put side by side.
     *
     * The other backends answer from memory - UPower and the profile daemon
     * from their proxies, the processor from a snapshot of files small enough
     * and hot enough that reading them costs tens of microseconds. The sensors
     * were the part that could block, and they arrive here already read.
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
            lineOnline: upower.lineOnline,
            temperatures: temperatures,
            fans: readings.fans,
            powers: powers,
            packageWatts: readings.packageWatts,
            cpu: this._cpu.snapshot(),
            profile: this._collectProfile(),
            chargeLimit: charge.limit,
            /* two batteries something else has set apart; see _updateCharge */
            chargeLimitDivided: charge.divided,
            cpuTemperature: picked.sensor === null ? null : picked.sensor.celsius,
            /* whether the user's hint is the reason it came from there -
             * false means they asked for a sensor and it was not found,
             * which is worth saying out loud */
            hintMatched: picked.hintMatched,
            systemWatts: power.watts,
            systemWattsSource: power.source,
        };
    }

    /*
     * The charge limit, read only when it could be looked at.
     *
     * It is deliberately a live read rather than something remembered: the
     * firmware and other tools change it too. But it appears in one place -
     * the device panel, behind the privileged controls - so with the menu shut
     * or those controls off there is nobody it could be read for, and it was
     * the last reading in the poll still being taken regardless.
     *
     * Opening the menu re-reads before anything is drawn, so what is on screen
     * is never the value from the last time the menu happened to be open.
     */
    _readChargeLimit() {
        if (!this._chargeControl || !this.enablePrivilegedControls)
            return { limit: null, divided: false };
        if (!this.menu || !this.menu.isOpen)
            return { limit: null, divided: false };
        return this._chargeControl.reading();
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
     * Which of the two backends answers, decided once here rather than at
     * every place that cares.
     *
     * power-profiles-daemon where it is running, the firmware's own profile
     * where it is not. When there is neither, the daemon client is still the
     * one asked: it answers unavailable, null and an empty list, which is
     * exactly how a machine with no profiles should read.
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
        if (this._latest)
            this._menuPresenter.update(this._latest, this._menuOptions());
        this._update();
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

    /*
     * What the panel text is, from one list rather than three switches.
     *
     * Three independent switches are eight arrangements to consider, and the
     * ones anybody wants are the charge, the charge and the draw, or nothing
     * at all. Those are the list; the switches are still there under "Choose
     * below" for the arrangement that is not on it.
     */
    _panelText() {
        switch (this.panelText) {
            case "none":
                return { battery: false, power: false, profile: false };
            case "battery-power":
                return { battery: true, power: true, profile: false };
            case "custom":
                return { battery: this.panelShowBattery, power: this.panelShowPower,
                         profile: this.panelShowProfile };
            default:
                return { battery: true, power: false, profile: false };
        }
    }

    /*
     * The switches, read once into the list that replaced them.
     *
     * A machine that has run this applet before has three switches set the way
     * somebody wanted them, and a new setting arrives at its default - so
     * without this, an upgrade would quietly take the power draw out of
     * somebody's panel. Where the switches say what one of the list's entries
     * says, that entry is chosen; where they say something else, the list is
     * put on "Choose below" and the switches keep doing exactly what they did.
     *
     * A fresh install has nothing to read: `introduced` is still false, the
     * switches are still at their defaults, and the default entry already
     * means what they mean. Run this before the greeting, which is what sets
     * that flag.
     */
    _migratePanelText() {
        if (this.panelTextMigrated)
            return;
        this.settings.setValue("panel-text-migrated", true);
        if (!this.introduced)
            return;

        let battery = this.panelShowBattery;
        let power = this.panelShowPower;
        let profile = this.panelShowProfile;
        let wanted = "custom";
        if (battery && !power && !profile)
            wanted = "battery";
        else if (battery && power && !profile)
            wanted = "battery-power";
        else if (!battery && !power && !profile)
            wanted = "none";

        if (wanted !== this.panelText)
            this.settings.setValue("panel-text", wanted);
    }

    _panelOptions() {
        let text = this._panelText();
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
            /* The two are independent spinbuttons with overlapping ranges, and
             * one order of them makes the other unreachable; see criticalBelow. */
            criticalLevel: Alerts.criticalBelow(this.criticalBatteryThreshold,
                                                this.lowBatteryThreshold),
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
        if (!this._pending.ask(name))
            return false;

        this._profileBackend.setProfile(name, error => {
            if (error) {
                this._pending.failed(name);
                /* Cancelling a password dialog is not news; the user did it. */
                if (error.message !== "cancelled")
                    this._notifyProfileError(name, error);
            } else {
                /* Taken. From here the machine is expected to adopt it, and
                 * PendingProfile is what stops it being drawn for ever if
                 * something else has other ideas. */
                this._pending.written(name);
            }
            this._scheduleUpdate();
        });

        /*
         * The menu stays open, and is redrawn now so that the segment fills
         * under the click rather than a poll later.
         *
         * It used to close here, which made a liar of the control: the point
         * of filling the segment that was chosen is that the change can be
         * seen, and it cannot be seen from a menu that has just shut. Nothing
         * else in this menu closes it either - the boost switch, the governor
         * and the charge limit all leave it up - and a profile change is the
         * moment the temperatures and the draw underneath are worth watching.
         * The click dismisses it if that is what was wanted.
         */
        this._scheduleUpdate();
        return true;
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
        this._helper.run(args, outcome => {
            if (this._destroyed)
                return;
            this._cpu.refresh();
            this._update();
            onDone(outcome);
        });
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

        let ordered = this._orderedProfiles(state);
        let from = Reading.shownProfile(this._latest, { pendingProfile: this._pending.value });
        let index = ordered.indexOf(from);
        if (index < 0)
            index = 0;

        let target = index + step;
        if (wrap)
            target = (target + ordered.length) % ordered.length;
        else
            target = Math.max(0, Math.min(ordered.length - 1, target));

        let name = ordered[target];
        if (name === from)
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
         * the wheel. The notch is the control's own, so on a kernel backlight
         * this moves by the same amount the brightness keys do.
         */
        if (this.scrollAction === "brightness") {
            if (!this._brightnessControl())
                return Clutter.EVENT_PROPAGATE;
            this._gatherScroll(up ? 1 : -1, notches => this._stepBrightness(notches));
            return Clutter.EVENT_STOP;
        }

        if (this.scrollAction !== "profile" || !this._profileState())
            return Clutter.EVENT_PROPAGATE;

        /* Announced, because the panel is not necessarily showing the profile
         * and otherwise nothing would say it had changed. */
        this._gatherScroll(up ? 1 : -1, notches => this._stepProfile(notches, false, true));
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
            let gathered = this._pendingScroll;
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

    _onIconThemeChanged() {
        if (this._destroyed)
            return;
        Format.forgetIcons();
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
        if (this._iconThemeId) {
            this._iconTheme.disconnect(this._iconThemeId);
            this._iconThemeId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._destroyMenu();
        /* Before the backends that feed it: whatever is queued here would
         * otherwise still put a password dialog on screen for an applet that
         * has left the panel. */
        if (this._helper)
            this._helper.destroy();
        if (this._profiles)
            this._profiles.destroy();
        if (this._platformProfiles)
            this._platformProfiles.destroy();
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
