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
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const UPowerGlib = imports.gi.UPowerGlib;
const Util = imports.misc.util;

const UUID = "cinnamon-powertoys@geraldo-netto";

/*
 * Cinnamon loads every xlet file through misc/fileUtils.js, which hands the
 * module a require() already bound to the xlet's own directory. Using it
 * instead of imports.searchPath keeps these libraries private to this applet,
 * where imports.lib.* would have registered them under a global name any other
 * xlet could collide with, and lets a reload pick up library edits: Cinnamon
 * drops the cached modules for the directory when the xlet is unloaded, while
 * the legacy importer caches them for the life of the process.
 */
const Cpu = require("./lib/cpu.js");
const IO = require("./lib/io.js");
const Sensors = require("./lib/sensors.js");
const Sysfs = require("./lib/sysfs.js");
const UPower = require("./lib/upower.js");
const Profiles = require("./lib/profiles.js");
const Format = require("./lib/format.js");

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    let translated = Gettext.dgettext(UUID, text);
    if (translated !== text)
        return translated;
    return Gettext.gettext(text);
}

const UPDeviceKind = UPowerGlib.DeviceKind;
const UPDeviceState = UPowerGlib.DeviceState;
const UPDeviceLevel = UPowerGlib.DeviceLevel;

const HELPER = "powertoys-helper";
const DEFAULT_ICON = "powertoys";
/* pkexec exit codes: the dialog was closed, or authorisation was refused */
const PKEXEC_DISMISSED = 126;
const PKEXEC_UNAUTHORISED = 127;
/* Only the top level RAPL domains, adding the sub-domains would count twice. */
const RAPL_PACKAGE = /^rapl:(intel|amd)-rapl:\d+$/;

/* Charge limits offered in the menu, in percent. */
const CHARGE_LIMITS = [60, 70, 80, 90, 95, 100];

/* Sensors are listed in this order, so the interesting ones come first. */
const SENSOR_KIND_ORDER = ["cpu", "gpu", "package", "battery", "board", "disk", "network", "other"];

/* Kept when the menu is not asked to list every sensor on the machine. */
const PRIMARY_SENSOR_KINDS = ["cpu", "gpu", "battery", "package"];

function bySensorOrder(a, b) {
    let rankA = SENSOR_KIND_ORDER.indexOf(a.kind);
    let rankB = SENSOR_KIND_ORDER.indexOf(b.kind);
    if (rankA < 0)
        rankA = SENSOR_KIND_ORDER.length;
    if (rankB < 0)
        rankB = SENSOR_KIND_ORDER.length;
    if (rankA !== rankB)
        return rankA - rankB;
    if (a.label === b.label)
        return 0;
    return a.label < b.label ? -1 : 1;
}

/*
 * Everything the applet reads the machine through, gathered in one bag. The
 * applet holds no direct reference to the sysfs, UPower or profile modules, so
 * handing it a different bag - a fixture directory, a stubbed bus - is enough
 * to construct it without a real machine underneath. The indirection is here
 * for the tests; at runtime this is always what gets passed.
 */
function defaultBackends() {
    return {
        discoverSensors: () => Sensors.discoverSensors(),
        energyMeters: () => Sensors.discoverEnergyCounters()
            .map(counter => new Sensors.EnergyMeter(counter)),
        cpuControl: () => new Cpu.CpuControl(),
        chargeControl: () => Sysfs.discoverChargeControl(),
        platformProfile: () => Sysfs.platformProfile(),
        profilesClient: onChanged => new Profiles.PowerProfilesClient(onChanged),
        upowerMonitor: (onChanged, onReady) => new UPower.UPowerMonitor(onChanged, onReady),
        readNumber: path => IO.readNumber(path),
        fileExists: path => IO.exists(path),
    };
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

/* Two line entry for one powered device: title with icon, details below. */
class DeviceRow extends PopupMenu.PopupBaseMenuItem {
    _init(device, applet) {
        super._init.call(this, { reactive: false });

        this._applet = applet;

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

        this.path = device.path;
        this.update(device);
    }

    update(device) {
        let title = Format.deviceTitle(device);
        if (Format.reportsPrecisePercentage(device))
            title += "  " + Format.percent(device.percentage);
        else if (device.batteryLevel !== UPDeviceLevel.NONE)
            title += "  " + Format.batteryLevelName(device.batteryLevel);
        this._title.set_text(title);

        /* Peripherals get an icon for what they are, since UPower often
         * reports battery-missing for them. Real batteries keep the UPower
         * icon, which encodes the charge level. St appends "-symbolic" itself,
         * so the suffix has to be stripped from the UPower name. */
        let iconName = device.powerSupply ? null : Format.deviceIconName(device.kind, null);
        if (!iconName && device.icon)
            iconName = device.icon.replace(/-symbolic$/, "");
        if (!iconName)
            iconName = Format.deviceIconName(device.kind, "xsi-battery-level-100");
        if (iconName !== this._iconName) {
            this._iconName = iconName;
            this._icon.icon_name = iconName;
        }

        this._details.set_text(this._applet.describeDevice(device));

        let low = device.percentage !== null &&
                  this._applet.isDraining(device) &&
                  device.percentage <= this._applet.lowThresholdFor(device);
        if (low)
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

class PowerToysApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId, backends) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this.instanceId = instanceId;
        this._backends = backends || defaultBackends();
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_show_label_in_vertical_panels(false);

        this._timerId = 0;
        this._iconKey = null;
        this._alerted = new Map();
        this._tempAlerted = false;
        this._hotkeyIds = [];

        this._bindSettings();

        this._sensors = this._backends.discoverSensors();
        this._energyMeters = this._backends.energyMeters();
        this._cpu = this._backends.cpuControl();
        this._chargeControl = this._backends.chargeControl();

        this._profiles = this._backends.profilesClient(() => this._scheduleUpdate());
        this._upower = this._backends.upowerMonitor(() => this._scheduleUpdate(),
                                                    () => this._scheduleUpdate());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._createMenu(orientation);

        this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event));

        this._registerHotkeys();
        this._startPolling();
        this._update();
    }

    /* ------------------------------------------------------------------ */
    /* settings                                                            */

    _bindSettings() {
        this.settings = new Settings.AppletSettings(this, UUID, this.instanceId);

        let plain = [
            "cpu-sensor-hint", "panel-icon-source",
            "panel-show-battery", "panel-show-temp", "panel-show-power",
            "panel-show-frequency", "panel-show-profile",
            "show-profiles", "show-cpu", "show-devices", "show-sensors",
            "show-all-sensors", "enable-privileged-controls",
            "scroll-action", "notify-low-battery", "low-battery-threshold",
            "critical-battery-threshold", "notify-peripheral-battery",
            "peripheral-battery-threshold", "notify-high-temp",
            "high-temp-threshold", "high-temp-threshold-fahrenheit",
        ];
        for (let key of plain)
            this.settings.bind(key, this._propertyName(key), () => this._onSettingsChanged());

        this.settings.bind("temp-unit", "tempUnit", () => this._onTempUnitChanged());
        this._tempUnitInUse = this.tempUnit;

        this.settings.bind("refresh-interval", "refreshInterval", () => this._startPolling());
        /* Applied on its own, so that toggling any other setting does not fold
         * a submenu the user opened by hand. */
        this.settings.bind("expand-sections", "expandSections", () => this._applyExpandState());
        this.settings.bind("cycle-profile-hotkey", "cycleProfileHotkey", () => this._registerHotkeys());
        this.settings.bind("toggle-menu-hotkey", "toggleMenuHotkey", () => this._registerHotkeys());
    }

    _propertyName(key) {
        return key.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
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
        this._iconKey = null;
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

        this._buildMenu();
    }

    _destroyMenu() {
        if (!this.menu)
            return;
        this.menuManager.removeMenu(this.menu);
        this.menu.destroy();
        this.menu = null;
    }

    _buildMenu() {
        this._summary = new InfoRow("", "");
        this._summary.actor.add_style_class_name("powertoys-summary");
        this.menu.addMenuItem(this._summary);

        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);
        this._profileGroup = new SelectorGroup(this._profileSection, Format.profileLabel,
                                               value => this._setProfile(value), "");

        this._degradedRow = new InfoRow(_("Performance limited"), "");
        this._degradedRow.setWarning(true);
        this._degradedRow.actor.hide();
        this.menu.addMenuItem(this._degradedRow);

        this._deviceSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._deviceSeparator);
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);
        this._deviceList = new KeyedList(this._deviceSection,
                                         entry => new DeviceRow(entry.device, this),
                                         (row, entry) => row.update(entry.device));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._cpuMenu = new PopupMenu.PopupSubMenuMenuItem(_("Processor"));
        this.menu.addMenuItem(this._cpuMenu);
        this._buildCpuMenu();

        this._sensorMenu = new PopupMenu.PopupSubMenuMenuItem(_("Sensors"));
        this.menu.addMenuItem(this._sensorMenu);
        this._sensorList = new KeyedList(this._sensorMenu.menu,
                                         entry => new InfoRow(entry.label, entry.value),
                                         (row, entry) => {
                                             row.setValue(entry.value);
                                             row.setWarning(entry.warning);
                                         });

        if (this._chargeControl) {
            this._chargeMenu = new PopupMenu.PopupSubMenuMenuItem(_("Battery charge limit"));
            this.menu.addMenuItem(this._chargeMenu);
            this._buildChargeMenu();
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_("System power settings"), "power");

        let configure = new PopupMenu.PopupIconMenuItem(_("Configure Power Toys"),
                                                        "system-run", St.IconType.SYMBOLIC);
        configure.connect("activate", () => {
            Util.spawnCommandLine("cinnamon-settings applets " + UUID + " " + this.instanceId);
        });
        this.menu.addMenuItem(configure);

        this._applyExpandState();
    }

    /* Submenus start folded; "expand-sections" asks for them open instead. */
    _applyExpandState() {
        for (let item of [this._cpuMenu, this._sensorMenu, this._chargeMenu]) {
            if (!item)
                continue;
            if (this.expandSections)
                item.menu.open(false);
            else
                item.menu.close(false);
        }
    }

    _buildCpuMenu() {
        let menu = this._cpuMenu.menu;

        this._cpuFreqRow = new InfoRow(_("Frequency"), "");
        this._cpuTempRow = new InfoRow(_("Temperature"), "");
        this._cpuDriverRow = new InfoRow(_("Scaling driver"), "");
        menu.addMenuItem(this._cpuFreqRow);
        menu.addMenuItem(this._cpuTempRow);
        menu.addMenuItem(this._cpuDriverRow);

        this._governorControl = new ChoiceControl(menu, _("Governor"), Format.governorLabel,
                                                  value => this._runHelper(["governor", value]));
        this._energyControl = new ChoiceControl(menu, _("Energy preference"),
                                                Format.energyPreferenceLabel,
                                                value => this._runHelper(["epp", value]));

        /* The switch carries its own read-only mode, so unlike the two lists
         * above it needs no second widget: insensitive still shows the state. */
        this._boostSwitch = new PopupMenu.PopupSwitchMenuItem(_("Turbo boost"), false);
        this._boostSwitch.connect("toggled", (item, state) => {
            this._runHelper(["boost", state ? "1" : "0"]);
        });
        menu.addMenuItem(this._boostSwitch);
    }

    _buildChargeMenu() {
        this._chargeGroup = new SelectorGroup(this._chargeMenu.menu, limit => limit + "%",
                                              value => this._runHelper(["charge-threshold", value]),
                                              "");
    }

    /* ------------------------------------------------------------------ */
    /* data collection                                                     */

    _collect() {
        let devices = this._upower.available ? this._upower.snapshot() : [];
        let primary = this._upower.available ? this._upower.displayDevice() : null;
        if (!primary) {
            for (let device of devices) {
                if (device.powerSupply &&
                    (device.kind === UPDeviceKind.BATTERY || device.kind === UPDeviceKind.UPS)) {
                    primary = device;
                    break;
                }
            }
        }

        let temperatures = [];
        for (let sensor of this._sensors.temperatures) {
            let raw = this._backends.readNumber(sensor.path);
            temperatures.push({
                id: sensor.id,
                chip: sensor.chip,
                kind: sensor.kind,
                label: Format.sensorLabel(sensor),
                critical: sensor.critical,
                celsius: raw === null ? null : raw / 1000,
            });
        }
        for (let device of devices) {
            if (device.temperature)
                temperatures.push({
                    id: "upower:" + device.path,
                    chip: Format.deviceTitle(device),
                    kind: "battery",
                    label: Format.deviceTitle(device),
                    critical: null,
                    celsius: device.temperature,
                });
        }

        let fans = this._sensors.fans.map(fan => ({
            id: fan.id,
            label: Format.sensorLabel(fan),
            kind: fan.kind,
            rpm: this._backends.readNumber(fan.path),
        }));

        let powers = [];
        let packageWatts = null;
        for (let meter of this._energyMeters) {
            let value = meter.sample();
            if (value === null)
                continue;
            powers.push({ id: meter.id, label: meter.label, kind: "package", watts: value });
            if (RAPL_PACKAGE.test(meter.id))
                packageWatts = (packageWatts || 0) + value;
        }
        for (let sensor of this._sensors.powerMeters) {
            let raw = this._backends.readNumber(sensor.path);
            if (raw === null)
                continue;
            powers.push({
                id: sensor.id,
                label: Format.sensorLabel(sensor),
                kind: sensor.kind,
                watts: raw / 1000000,
            });
        }
        for (let device of devices) {
            if (device.powerSupply && device.energyRate)
                powers.push({
                    id: "upower:" + device.path,
                    label: Format.deviceTitle(device),
                    kind: "battery",
                    watts: device.energyRate,
                    charging: device.state === UPDeviceState.CHARGING,
                });
        }

        let cpu = {
            available: this._cpu.available,
            driver: this._cpu.driver,
            governor: this._cpu.governor,
            governors: this._cpu.governors,
            energyPreference: this._cpu.energyPreference,
            energyPreferences: this._cpu.energyPreferences,
            boostSupported: this._cpu.boostSupported,
            boostEnabled: this._cpu.boostEnabled,
            averageFrequency: this._cpu.averageFrequency(),
            maxFrequency: this._cpu.maxFrequency(),
            amdPstateStatus: this._cpu.amdPstateStatus,
        };

        let profile = {
            available: this._profiles.available,
            backend: this._profiles.busName,
            active: this._profiles.active,
            list: this._profiles.profiles,
            degraded: this._profiles.degraded,
            holds: this._profiles.holds,
            viaSysfs: false,
        };
        if (!profile.available) {
            let platform = this._backends.platformProfile();
            if (platform && platform.choices.length > 0) {
                profile = {
                    available: true,
                    backend: "acpi-platform-profile",
                    active: platform.active,
                    list: platform.choices,
                    degraded: "",
                    holds: [],
                    viaSysfs: true,
                };
            }
        }

        let data = {
            devices: devices,
            primary: primary,
            onBattery: this._upower.onBattery,
            lineOnline: this._upower.lineDevices().some(device => device.online),
            temperatures: temperatures,
            fans: fans,
            powers: powers,
            packageWatts: packageWatts,
            cpu: cpu,
            profile: profile,
        };

        data.cpuTemperature = this._pickTemperature(temperatures);
        let power = this._pickPower(data);
        data.systemWatts = power.watts;
        data.systemWattsSource = power.source;
        return data;
    }

    /* The sensor shown in the panel: user hint first, then a CPU sensor,
     * then a GPU one, then whatever is left. */
    _pickTemperature(temperatures) {
        let readable = temperatures.filter(sensor => sensor.celsius !== null);
        if (readable.length === 0)
            return null;

        let hint = (this.cpuSensorHint || "").trim().toLowerCase();
        if (hint) {
            let match = readable.find(sensor =>
                sensor.label.toLowerCase().indexOf(hint) >= 0 ||
                sensor.chip.toLowerCase().indexOf(hint) >= 0);
            if (match)
                return match.celsius;
        }

        let preferred = ["tctl", "tdie", "package id 0", "cpu"];
        let cpus = readable.filter(sensor => sensor.kind === "cpu");
        for (let name of preferred) {
            let match = cpus.find(sensor => sensor.label.toLowerCase().indexOf(name) >= 0);
            if (match)
                return match.celsius;
        }
        if (cpus.length > 0)
            return cpus[0].celsius;

        let gpu = readable.find(sensor => sensor.kind === "gpu");
        return gpu ? gpu.celsius : readable[0].celsius;
    }

    /* Battery drain is the honest number while on battery; otherwise fall back
     * to the RAPL package counter and finally to the GPU meters. The source is
     * reported alongside the value, since these measure very different things. */
    _pickPower(data) {
        if (data.primary && data.primary.state === UPDeviceState.DISCHARGING && data.primary.energyRate)
            return { watts: data.primary.energyRate, source: "battery" };
        if (data.packageWatts !== null)
            return { watts: data.packageWatts, source: "package" };
        let gpus = data.powers.filter(entry => entry.kind === "gpu");
        if (gpus.length > 0)
            return { watts: gpus.reduce((total, entry) => total + entry.watts, 0), source: "gpu" };
        return { watts: null, source: null };
    }

    _powerSourceLabel(source) {
        switch (source) {
            case "battery": return _("battery");
            case "package": return _("package");
            case "gpu": return _("GPU");
            default: return "";
        }
    }

    _powerText(data) {
        if (data.systemWatts === null)
            return "";
        let label = this._powerSourceLabel(data.systemWattsSource);
        return Format.watts(data.systemWatts) + (label ? " (" + label + ")" : "");
    }

    /* ------------------------------------------------------------------ */
    /* update                                                              */

    _scheduleUpdate() {
        if (this._idleId)
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
        this._timerId = Mainloop.timeout_add_seconds(interval, () => {
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
        /* Sensors can appear at runtime (a USB device, a card waking up). */
        this._sensors = this._backends.discoverSensors();
        this._cpu.refresh();
        if (this._upower.available)
            this._upower.refresh();
        this._update();
    }

    _update() {
        let data;
        try {
            data = this._collect();
        } catch (error) {
            global.logError("[powertoys] collection failed: " + error);
            return;
        }
        this._latest = data;
        this._updatePanel(data);
        this._updateMenu(data);
        this._checkAlerts(data);
    }

    /* ------------------------------------------------------------------ */
    /* panel                                                               */

    _updatePanel(data) {
        let parts = [];
        if (this.panelShowBattery && data.primary && data.primary.percentage !== null)
            parts.push(Format.percent(data.primary.percentage));
        if (this.panelShowTemp && data.cpuTemperature !== null)
            parts.push(Format.temperature(data.cpuTemperature, this.tempUnit, 0));
        if (this.panelShowPower && data.systemWatts !== null)
            parts.push(Format.watts(data.systemWatts));
        if (this.panelShowFrequency && data.cpu.averageFrequency !== null)
            parts.push(Format.frequency(data.cpu.averageFrequency));
        if (this.panelShowProfile && data.profile.active)
            parts.push(Format.profileLabel(data.profile.active));
        this.set_applet_label(parts.join(" "));

        this._updateIcon(data);
        this.set_applet_tooltip(this._buildTooltip(data));
    }

    _updateIcon(data) {
        let source = this.panelIconSource || "auto";
        if (source === "auto")
            source = data.primary ? "battery" : (data.profile.active ? "profile" : "static");

        if (source === "battery" && data.primary) {
            let icon = data.primary.icon;
            let key = "battery:" + icon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            this.set_applet_icon_symbolic_name("xsi-battery-level-100");
            if (icon)
                this._applet_icon.gicon = Gio.icon_new_for_string(icon);
            return;
        }

        let name = DEFAULT_ICON;
        if (source === "profile" && data.profile.active)
            name = Format.profileIconName(data.profile.active);
        let key = "symbolic:" + name;
        if (key === this._iconKey)
            return;
        this._iconKey = key;
        this.set_applet_icon_symbolic_name(name);
    }

    _buildTooltip(data) {
        let lines = [];

        if (data.primary) {
            lines.push(Format.deviceKindName(data.primary.kind) + " " +
                       Format.percent(data.primary.percentage) + " - " +
                       Format.deviceStateName(data.primary.state));
            let remaining = this._remainingText(data.primary);
            if (remaining)
                lines.push(remaining);
        } else if (data.lineOnline || !this._upower.available) {
            lines.push(_("Running on AC power"));
        }

        if (data.profile.active)
            lines.push(_("Profile") + ": " + Format.profileLabel(data.profile.active));
        if (data.cpu.governor)
            lines.push(_("Governor") + ": " + Format.governorLabel(data.cpu.governor));
        if (data.cpuTemperature !== null)
            lines.push(_("Temperature") + ": " + Format.temperature(data.cpuTemperature, this.tempUnit, 1));
        if (data.systemWatts !== null)
            lines.push(_("Power draw") + ": " + this._powerText(data));

        let peripherals = data.devices.filter(device => !device.powerSupply && device.percentage !== null);
        for (let device of peripherals)
            lines.push(Format.deviceTitle(device) + ": " + Format.percent(device.percentage));

        if (lines.length === 0)
            lines.push(_("Power Toys"));
        return lines.join("\n");
    }

    _remainingText(device) {
        if (device.state === UPDeviceState.DISCHARGING && device.timeToEmpty)
            return Format.duration(device.timeToEmpty) + " " + _("remaining");
        if (device.state === UPDeviceState.CHARGING && device.timeToFull)
            return Format.duration(device.timeToFull) + " " + _("until full");
        return "";
    }

    /*
     * The level at which a device counts as low. A mouse at 18% is not a
     * laptop at 18%, so peripherals carry their own limit; both the row colour
     * and the notification read it from here.
     */
    lowThresholdFor(device) {
        return device.powerSupply ? this.lowBatteryThreshold : this.peripheralBatteryThreshold;
    }

    /*
     * Whether the device is spending its charge rather than taking it in.
     * System batteries report a state that can be trusted; peripherals very
     * often report none at all, so for those anything that is not explicitly
     * on the cable counts as draining.
     */
    isDraining(device) {
        if (device.powerSupply)
            return device.state === UPDeviceState.DISCHARGING;
        return device.state !== UPDeviceState.CHARGING &&
               device.state !== UPDeviceState.FULLY_CHARGED &&
               device.state !== UPDeviceState.PENDING_CHARGE;
    }

    /* One line summary of a device, used in the menu rows. */
    describeDevice(device) {
        let parts = [];
        /* Peripherals usually report no state at all, saying "Unknown" adds
         * nothing; name what the device is instead. */
        if (device.state === UPDeviceState.UNKNOWN)
            parts.push(Format.deviceKindName(device.kind));
        else
            parts.push(Format.deviceStateName(device.state));

        let remaining = this._remainingText(device);
        if (remaining)
            parts.push(remaining);
        if (device.energyRate)
            parts.push(Format.watts(device.energyRate));
        if (device.voltage)
            parts.push(Format.volts(device.voltage));
        if (device.temperature)
            parts.push(Format.temperature(device.temperature, this.tempUnit, 1));
        if (device.capacity && device.capacity < 100)
            parts.push(_("health") + " " + Format.percent(device.capacity));
        if (device.cycles && device.cycles > 0)
            parts.push(device.cycles + " " + _("cycles"));
        if (device.energy && device.energyFull)
            parts.push(Format.energy(device.energy) + " / " + Format.energy(device.energyFull));

        return parts.filter(part => part !== "").join(" · ");
    }

    /* ------------------------------------------------------------------ */
    /* menu contents                                                       */

    _updateMenu(data) {
        this._updateSummary(data);
        this._updateProfileSection(data);
        this._updateDeviceSection(data);
        this._updateCpuSection(data);
        this._updateSensorSection(data);
        this._updateChargeSection();
    }

    _updateSummary(data) {
        if (data.primary) {
            this._summary.setLabel(Format.deviceKindName(data.primary.kind) + " " +
                                   Format.percent(data.primary.percentage));
            let detail = Format.deviceStateName(data.primary.state);
            let remaining = this._remainingText(data.primary);
            if (remaining)
                detail += " · " + remaining;
            this._summary.setValue(detail);
        } else {
            this._summary.setLabel(_("On AC power"));
            let detail = [];
            if (data.cpuTemperature !== null)
                detail.push(Format.temperature(data.cpuTemperature, this.tempUnit, 1));
            if (data.systemWatts !== null)
                detail.push(this._powerText(data));
            this._summary.setValue(detail.join(" · "));
        }
    }

    _updateProfileSection(data) {
        let show = this.showProfiles && data.profile.available && data.profile.list.length > 0;
        this._profileGroup.sync(show ? data.profile.list : [], data.profile.active);

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

    _updateDeviceSection(data) {
        let show = this.showDevices && data.devices.length > 0;
        this._deviceSeparator.actor.visible = show;
        this._deviceList.sync(show
            ? data.devices.map(device => ({ key: device.path, device: device }))
            : []);
    }

    _updateCpuSection(data) {
        let show = this.showCpu && data.cpu.available;
        this._cpuMenu.actor.visible = show;
        if (!show)
            return;

        let frequency = Format.frequency(data.cpu.averageFrequency);
        if (data.cpu.maxFrequency)
            frequency += " / " + Format.frequency(data.cpu.maxFrequency);
        this._cpuFreqRow.setValue(frequency);

        this._cpuTempRow.actor.visible = data.cpuTemperature !== null;
        if (data.cpuTemperature !== null) {
            this._cpuTempRow.setValue(Format.temperature(data.cpuTemperature, this.tempUnit, 1));
            this._cpuTempRow.setWarning(data.cpuTemperature >= this.highTempCelsius);
        }

        let driver = data.cpu.driver || _("unknown");
        if (data.cpu.amdPstateStatus)
            driver += " (" + data.cpu.amdPstateStatus + ")";
        this._cpuDriverRow.setValue(driver);

        let editable = this.enablePrivilegedControls;
        this._governorControl.sync(data.cpu.governors, data.cpu.governor, editable);
        this._energyControl.sync(data.cpu.energyPreferences, data.cpu.energyPreference, editable);

        this._boostSwitch.actor.visible = data.cpu.boostSupported;
        if (data.cpu.boostSupported) {
            if (data.cpu.boostEnabled !== null)
                this._boostSwitch.setToggleState(data.cpu.boostEnabled);
            this._boostSwitch.setSensitive(editable);
        }
    }

    /* A temperature is worth flagging as it closes on the chip's own limit. */
    _temperatureEntry(sensor) {
        return {
            key: "t:" + sensor.id,
            label: sensor.label,
            value: Format.temperature(sensor.celsius, this.tempUnit, 1),
            warning: sensor.critical !== null && sensor.celsius >= sensor.critical - 5,
        };
    }

    _fanEntry(fan) {
        return { key: "f:" + fan.id, label: fan.label, value: Format.rpm(fan.rpm), warning: false };
    }

    _powerEntry(meter) {
        return { key: "p:" + meter.id, label: meter.label,
                 value: Format.watts(meter.watts), warning: false };
    }

    /*
     * One kind of reading turned into menu entries: drop what cannot be read,
     * drop the uninteresting kinds unless the menu was asked for all of them,
     * then order them the way the menu lists sensors.
     */
    _sensorEntries(readings, isReadable, toEntry) {
        let usable = readings.filter(isReadable);
        if (!this.showAllSensors)
            usable = usable.filter(reading => PRIMARY_SENSOR_KINDS.indexOf(reading.kind) >= 0);
        return usable.sort(bySensorOrder).map(toEntry);
    }

    _updateSensorSection(data) {
        this._sensorMenu.actor.visible = this.showSensors;
        if (!this.showSensors)
            return;

        let entries = [].concat(
            this._sensorEntries(data.temperatures, sensor => sensor.celsius !== null,
                                sensor => this._temperatureEntry(sensor)),
            this._sensorEntries(data.fans, fan => fan.rpm !== null && fan.rpm > 0,
                                fan => this._fanEntry(fan)),
            this._sensorEntries(data.powers, () => true,
                                meter => this._powerEntry(meter)));

        if (entries.length === 0)
            entries.push({ key: "empty", label: _("No sensors found"), value: "", warning: false });

        this._sensorList.sync(entries);
    }

    _updateChargeSection() {
        if (!this._chargeMenu)
            return;
        let allowed = this.enablePrivilegedControls;
        this._chargeMenu.actor.visible = allowed;
        if (!allowed)
            return;
        let current = this._backends.readNumber(this._chargeControl.path);
        this._chargeMenu.label.set_text(_("Battery charge limit") +
                                        (current !== null ? "  " + current + "%" : ""));
        this._chargeGroup.sync(CHARGE_LIMITS, current);
    }

    /* ------------------------------------------------------------------ */
    /* actions                                                             */

    _setProfile(name) {
        let data = this._latest;
        if (data && data.profile.viaSysfs) {
            /* the helper reports its own failures */
            this._runHelper(["platform-profile", name]);
        } else {
            this._profiles.setProfile(name, error => {
                if (error)
                    this._notifyProfileError(name, error);
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
     */
    _runHelper(args, onDone) {
        if (!this.enablePrivilegedControls)
            return;

        let helper = this.metadata.path + "/" + HELPER;
        if (!this._backends.fileExists(helper)) {
            Main.notifyError(_("Power Toys"), _("Helper script not found") + ": " + helper);
            return;
        }
        this._ensureExecutable(helper);

        let command = "pkexec " + GLib.shell_quote(helper) + " " +
                      args.map(argument => GLib.shell_quote(String(argument))).join(" ");
        try {
            Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
                this._cpu.refresh();
                this._update();

                if (exitCode === 0) {
                    if (onDone)
                        onDone();
                    return;
                }

                /* Nothing was changed and the user knows why: they closed the
                 * dialog or the password did not check out. */
                if (exitCode === PKEXEC_DISMISSED || exitCode === PKEXEC_UNAUTHORISED)
                    return;

                this._notifyHelperError(stderr);
            });
        } catch (error) {
            global.logError("[powertoys] helper failed: " + error);
            this._notifyHelperError(String(error));
        }
    }

    /* The helper explains itself on stderr, so the last line is the reason. */
    _notifyHelperError(stderr) {
        let lines = (stderr || "").split("\n").map(line => line.trim()).filter(line => line !== "");
        let detail = lines.length > 0 ? lines[lines.length - 1] : "";
        detail = detail.replace(/^powertoys-helper:\s*/, "");
        Main.notifyError(_("Power Toys"), detail || _("The change could not be applied."));
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

    _onScroll(actor, event) {
        if (this.scrollAction !== "profile" || !this._profileState())
            return Clutter.EVENT_PROPAGATE;

        let direction = event.get_scroll_direction();
        let step;
        if (direction === Clutter.ScrollDirection.UP)
            step = 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            step = -1;
        else
            return Clutter.EVENT_PROPAGATE;

        /* No wrapping here: the wheel should stop at the ends rather than
         * jump from performance back to power saver. */
        this._stepProfile(step, false, false);
        return Clutter.EVENT_STOP;
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
    /* alerts                                                              */

    _checkAlerts(data) {
        for (let device of data.devices) {
            if (device.percentage === null)
                continue;

            let system = device.powerSupply;
            let enabled = system ? this.notifyLowBattery : this.notifyPeripheralBattery;
            let threshold = this.lowThresholdFor(device);
            let level = this._alerted.get(device.path) || "";

            if (!enabled || !this.isDraining(device)) {
                this._alerted.delete(device.path);
                continue;
            }

            if (system && device.percentage <= this.criticalBatteryThreshold) {
                if (level !== "critical") {
                    this._alerted.set(device.path, "critical");
                    Main.criticalNotify(_("Battery critically low"),
                                        Format.deviceTitle(device) + " - " +
                                        Format.percent(device.percentage));
                }
            } else if (device.percentage <= threshold) {
                if (level === "") {
                    this._alerted.set(device.path, "low");
                    Main.notify(_("Battery low"),
                                Format.deviceTitle(device) + " - " + Format.percent(device.percentage));
                }
            } else if (device.percentage > threshold + 5) {
                /* hysteresis, so a device hovering at the limit is not noisy */
                this._alerted.delete(device.path);
            }
        }

        if (!this.notifyHighTemp || data.cpuTemperature === null) {
            this._tempAlerted = false;
            return;
        }
        if (data.cpuTemperature >= this.highTempCelsius) {
            if (!this._tempAlerted) {
                this._tempAlerted = true;
                Main.notify(_("High temperature"),
                            Format.temperature(data.cpuTemperature, this.tempUnit, 1));
            }
        } else if (data.cpuTemperature < this.highTempCelsius - 5) {
            this._tempAlerted = false;
        }
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
        this._iconKey = null;
        this._update();
    }

    on_applet_removed_from_panel() {
        this._stopPolling();
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
        if (this.settings)
            this.settings.finalize();
    }
}

/* Cinnamon calls this with four arguments; the fifth is for the tests. */
function main(metadata, orientation, panelHeight, instanceId, backends) {
    return new PowerToysApplet(metadata, orientation, panelHeight, instanceId, backends);
}
