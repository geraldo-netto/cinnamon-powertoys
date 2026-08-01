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
const APPLET_PATH = imports.ui.appletManager.appletMeta[UUID].path;

imports.searchPath.unshift(APPLET_PATH);
const Sysfs = imports.lib.sysfs;
const UPower = imports.lib.upower;
const Profiles = imports.lib.profiles;
const Format = imports.lib.format;
imports.searchPath.shift();

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

/* Sensors are listed in this order, so the interesting ones come first. */
const SENSOR_KIND_ORDER = ["cpu", "gpu", "package", "battery", "board", "disk", "network", "other"];

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
                  device.state === UPDeviceState.DISCHARGING &&
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

class PowerToysApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this.instanceId = instanceId;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_show_label_in_vertical_panels(false);

        this._timerId = 0;
        this._iconKey = null;
        this._alerted = new Map();
        this._tempAlerted = false;
        this._deviceRows = new Map();
        this._sensorRows = new Map();
        this._profileItems = [];
        this._governorItems = [];
        this._energyItems = [];
        this._deviceKey = "";
        this._sensorKey = "";
        this._profileKey = "";
        this._hotkeyIds = [];

        this._bindSettings();

        this._sensors = Sysfs.discoverSensors();
        this._energyMeters = Sysfs.discoverEnergyCounters().map(counter => new Sysfs.EnergyMeter(counter));
        this._cpu = new Sysfs.CpuControl();
        this._chargeControl = Sysfs.discoverChargeControl();

        this._profiles = new Profiles.PowerProfilesClient(() => this._scheduleUpdate());
        this._upower = new UPower.UPowerMonitor(() => this._scheduleUpdate(),
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
            "temp-unit", "cpu-sensor-hint", "panel-icon-source",
            "panel-show-battery", "panel-show-temp", "panel-show-power",
            "panel-show-frequency", "panel-show-profile",
            "show-profiles", "show-cpu", "show-devices", "show-sensors",
            "show-all-sensors", "enable-privileged-controls",
            "scroll-action", "notify-low-battery", "low-battery-threshold",
            "critical-battery-threshold", "notify-peripheral-battery",
            "peripheral-battery-threshold", "notify-high-temp", "high-temp-threshold",
        ];
        for (let key of plain)
            this.settings.bind(key, this._propertyName(key), () => this._onSettingsChanged());

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

    _onSettingsChanged() {
        this._deviceKey = "";
        this._sensorKey = "";
        this._profileKey = "";
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

        this._deviceKey = "";
        this._sensorKey = "";
        this._profileKey = "";
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

        this._degradedRow = new InfoRow(_("Performance limited"), "");
        this._degradedRow.setWarning(true);
        this._degradedRow.actor.hide();
        this.menu.addMenuItem(this._degradedRow);

        this._deviceSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._deviceSeparator);
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._cpuMenu = new PopupMenu.PopupSubMenuMenuItem(_("Processor"));
        this.menu.addMenuItem(this._cpuMenu);
        this._buildCpuMenu();

        this._sensorMenu = new PopupMenu.PopupSubMenuMenuItem(_("Sensors"));
        this.menu.addMenuItem(this._sensorMenu);

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

        /* Shown in place of the selectable items when the privileged controls
         * are turned off: the values are still worth reading. */
        this._governorRow = new InfoRow(_("Governor"), "");
        this._energyRow = new InfoRow(_("Energy preference"), "");
        this._boostRow = new InfoRow(_("Turbo boost"), "");
        menu.addMenuItem(this._governorRow);
        menu.addMenuItem(this._energyRow);
        menu.addMenuItem(this._boostRow);

        this._governorSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._governorSection);

        this._energySection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._energySection);

        this._boostSwitch = new PopupMenu.PopupSwitchMenuItem(_("Turbo boost"), false);
        this._boostSwitch.connect("toggled", (item, state) => {
            this._runHelper(["boost", state ? "1" : "0"]);
        });
        menu.addMenuItem(this._boostSwitch);
    }

    _buildChargeMenu() {
        let menu = this._chargeMenu.menu;
        this._chargeItems = [];
        for (let limit of [60, 70, 80, 90, 95, 100]) {
            let item = new SelectorItem(limit + "%", limit, false,
                                        value => this._runHelper(["charge-threshold", value]));
            this._chargeItems.push(item);
            menu.addMenuItem(item);
        }
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
            let raw = Sysfs.readNumber(sensor.path);
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
            rpm: Sysfs.readNumber(fan.path),
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
            let raw = Sysfs.readNumber(sensor.path);
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
            let platform = Sysfs.platformProfile();
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
        this._sensors = Sysfs.discoverSensors();
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
        let key = show ? data.profile.list.join(",") + "|" + data.profile.viaSysfs : "";

        if (key !== this._profileKey) {
            this._profileKey = key;
            this._profileSection.removeAll();
            this._profileItems = [];
            if (show) {
                for (let name of data.profile.list) {
                    let item = new SelectorItem(Format.profileLabel(name), name,
                                                name === data.profile.active,
                                                value => this._setProfile(value));
                    this._profileItems.push(item);
                    this._profileSection.addMenuItem(item);
                }
            }
        }

        for (let item of this._profileItems)
            item.setSelected(item.value === data.profile.active);

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

        let key = show ? data.devices.map(device => device.path).join(",") : "";
        if (key !== this._deviceKey) {
            this._deviceKey = key;
            this._deviceSection.removeAll();
            this._deviceRows = new Map();
            if (show) {
                for (let device of data.devices) {
                    let row = new DeviceRow(device, this);
                    this._deviceRows.set(device.path, row);
                    this._deviceSection.addMenuItem(row);
                }
            }
            return;
        }

        for (let device of data.devices) {
            let row = this._deviceRows.get(device.path);
            if (row)
                row.update(device);
        }
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

        if (data.cpuTemperature !== null) {
            this._cpuTempRow.setValue(Format.temperature(data.cpuTemperature, this.tempUnit, 1));
            this._cpuTempRow.setWarning(data.cpuTemperature >= this.highTempThreshold);
            this._cpuTempRow.actor.show();
        } else {
            this._cpuTempRow.actor.hide();
        }

        let driver = data.cpu.driver || _("unknown");
        if (data.cpu.amdPstateStatus)
            driver += " (" + data.cpu.amdPstateStatus + ")";
        this._cpuDriverRow.setValue(driver);

        let allowed = this.enablePrivilegedControls;

        this._governorRow.setValue(Format.governorLabel(data.cpu.governor));
        this._governorRow.actor.visible = !allowed && !!data.cpu.governor;

        this._energyRow.setValue(Format.energyPreferenceLabel(data.cpu.energyPreference));
        this._energyRow.actor.visible = !allowed && !!data.cpu.energyPreference;

        this._boostRow.setValue(data.cpu.boostEnabled ? _("On") : _("Off"));
        this._boostRow.actor.visible = !allowed && data.cpu.boostEnabled !== null;

        this._syncSelectors(this._governorSection, "_governorItems", allowed ? data.cpu.governors : [],
                            data.cpu.governor, Format.governorLabel,
                            value => this._runHelper(["governor", value]), _("Governor"));

        this._syncSelectors(this._energySection, "_energyItems", allowed ? data.cpu.energyPreferences : [],
                            data.cpu.energyPreference, Format.energyPreferenceLabel,
                            value => this._runHelper(["epp", value]), _("Energy preference"));

        let boost = data.cpu.boostSupported && allowed;
        this._boostSwitch.actor.visible = boost;
        if (boost && data.cpu.boostEnabled !== null)
            this._boostSwitch.setToggleState(data.cpu.boostEnabled);
    }

    /* Rebuilds a titled group of radio items only when the option list changes. */
    _syncSelectors(section, itemsProperty, values, active, labelFunction, onActivate, title) {
        let key = values.join(",");
        if (section._powertoysKey !== key) {
            section._powertoysKey = key;
            section.removeAll();
            this[itemsProperty] = [];
            if (values.length > 0) {
                let header = new PopupMenu.PopupMenuItem(title, { reactive: false });
                header.actor.add_style_class_name("powertoys-group-title");
                section.addMenuItem(header);
                for (let value of values) {
                    let item = new SelectorItem(labelFunction(value), value, value === active, onActivate);
                    this[itemsProperty].push(item);
                    section.addMenuItem(item);
                }
            }
        }
        for (let item of this[itemsProperty])
            item.setSelected(item.value === active);
    }

    _updateSensorSection(data) {
        let show = this.showSensors;
        this._sensorMenu.actor.visible = show;
        if (!show)
            return;

        let temperatures = data.temperatures.filter(sensor => sensor.celsius !== null);
        let fans = data.fans.filter(fan => fan.rpm !== null && fan.rpm > 0);
        let powers = data.powers;

        if (!this.showAllSensors) {
            let wanted = ["cpu", "gpu", "battery", "package"];
            temperatures = temperatures.filter(sensor => wanted.indexOf(sensor.kind) >= 0);
            fans = fans.filter(fan => wanted.indexOf(fan.kind) >= 0);
            powers = powers.filter(entry => wanted.indexOf(entry.kind) >= 0);
        }

        temperatures.sort(bySensorOrder);
        fans.sort(bySensorOrder);
        powers.sort(bySensorOrder);

        let entries = [];
        for (let sensor of temperatures)
            entries.push({ id: "t:" + sensor.id, label: sensor.label,
                           value: Format.temperature(sensor.celsius, this.tempUnit, 1),
                           warning: sensor.critical !== null && sensor.celsius >= sensor.critical - 5 });
        for (let fan of fans)
            entries.push({ id: "f:" + fan.id, label: fan.label, value: Format.rpm(fan.rpm), warning: false });
        for (let entry of powers)
            entries.push({ id: "p:" + entry.id, label: entry.label,
                           value: Format.watts(entry.watts), warning: false });

        let key = entries.map(entry => entry.id).join(",");
        if (key !== this._sensorKey) {
            this._sensorKey = key;
            this._sensorMenu.menu.removeAll();
            this._sensorRows = new Map();
            if (entries.length === 0) {
                this._sensorMenu.menu.addMenuItem(new InfoRow(_("No sensors found"), ""));
            } else {
                for (let entry of entries) {
                    let row = new InfoRow(entry.label, entry.value);
                    this._sensorRows.set(entry.id, row);
                    this._sensorMenu.menu.addMenuItem(row);
                }
            }
        }

        for (let entry of entries) {
            let row = this._sensorRows.get(entry.id);
            if (!row)
                continue;
            row.setValue(entry.value);
            row.setWarning(entry.warning);
        }
    }

    _updateChargeSection() {
        if (!this._chargeMenu)
            return;
        let allowed = this.enablePrivilegedControls;
        this._chargeMenu.actor.visible = allowed;
        if (!allowed)
            return;
        let current = Sysfs.readNumber(this._chargeControl.path);
        this._chargeMenu.label.set_text(_("Battery charge limit") +
                                        (current !== null ? "  " + current + "%" : ""));
        for (let item of this._chargeItems)
            item.setSelected(item.value === current);
    }

    /* ------------------------------------------------------------------ */
    /* actions                                                             */

    _setProfile(name) {
        let data = this._latest;
        if (data && data.profile.viaSysfs)
            this._runHelper(["platform-profile", name]);
        else
            this._profiles.setProfile(name);
        this.menu.close();
        this._scheduleUpdate();
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
        if (!Sysfs.exists(helper)) {
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

            if (!enabled || (system && device.state !== UPDeviceState.DISCHARGING)) {
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
        if (data.cpuTemperature >= this.highTempThreshold) {
            if (!this._tempAlerted) {
                this._tempAlerted = true;
                Main.notify(_("High temperature"),
                            Format.temperature(data.cpuTemperature, this.tempUnit, 1));
            }
        } else if (data.cpuTemperature < this.highTempThreshold - 5) {
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

function main(metadata, orientation, panelHeight, instanceId) {
    return new PowerToysApplet(metadata, orientation, panelHeight, instanceId);
}
