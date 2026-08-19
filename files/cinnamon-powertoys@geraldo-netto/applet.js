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
const Collection = require("./lib/collection.js");
const Cpu = require("./lib/cpu.js");
const Ddc = require("./lib/ddc.js");
const Device = require("./lib/device.js");
const Input = require("./lib/input.js");
const SettingsTable = require("./lib/settings.js");
const SensorRows = require("./lib/sensor-rows.js");
const Log = require("./lib/log.js");
const MonitorWatch = require("./lib/monitor-watch.js");
const Notifications = require("./lib/notifications.js");
const PanelText = require("./lib/panel-text.js");
const PendingProfile = require("./lib/pending-profile.js");
const PowerSupply = require("./lib/power-supply.js");
const ScrollGatherer = require("./lib/scroll-gatherer.js");
const ShellMetrics = require("./lib/shell-metrics.js");
const Privileged = require("./lib/privileged.js");
const ProfileSelection = require("./lib/profile-selection.js");
const ProfileView = require("./lib/profile-view.js");
const Panel = require("./lib/panel-presenter.js");
const Sensors = require("./lib/sensors.js");
const Translate = require("./lib/gettext.js");
const UPower = require("./lib/upower.js");
const Profiles = require("./lib/profiles.js");
const Reading = require("./lib/reading.js");
const Format = require("./lib/format.js");
const HelperMessages = require("./lib/helper-messages.js");
const Controls = require("./ui/controls.js");
const Menu = require("./ui/menu.js");

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

/*
 * Where `make install-policy` puts the root-owned helper and the path the
 * polkit action names. PrivilegedHelper verifies this file and every parent
 * before asking pkexec to run it. The copy inside the applet is deliberately
 * never elevated: its owner could replace it between validation and use.
 */
const SYSTEM_HELPER = "/usr/local/lib/cinnamon-powertoys/powertoys-helper";

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
            onChanged: onChanged,
        }),
        chargeControl: (runner, onChanged) =>
            new PowerSupply.ChargeControl(runner, onChanged),
        platformProfileClient: (runner, onChanged) =>
            new PowerSupply.PlatformProfileClient(runner, {
                asynchronous: true,
                onChanged: onChanged,
            }),
        profilesClient: onChanged => new Profiles.PowerProfilesClient(onChanged),
        backlight: (kind, onChanged, onReady) =>
            new Backlight.BacklightControl(kind, onChanged, onReady),
        monitorBacklight: onChanged => new Ddc.DdcBacklight(onChanged),
        bluetoothBatteries: onChanged => new Bluez.BluezBatteries(onChanged),
        upowerMonitor: (onChanged, onReady) => new UPower.UPowerMonitor(onChanged, onReady),
        notifications: () => new Notifications.NotificationCenter(Main),
        privilegedHelper: candidates => new Privileged.PrivilegedHelper(candidates),
    };
}


/*
 * The applet coordinator.
 *
 * It binds the settings, builds the backends, owns the poll timer, assembles
 * one reading from those backends, hands that reading to the panel, the menu
 * and the alert policy, and turns what the user does - a click, the wheel, a
 * hotkey - into a call on a backend. It also owns backend selection,
 * privileged-change coordination and teardown. Panel and menu presentation
 * stay in their presenters above, Cinnamon compatibility in
 * lib/cinnamon-panel.js, and machine access plus reusable derived policy in
 * the other libraries.
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
        this._notifications = null;
        this._sensors = null;
        this._cpu = null;
        this._chargeControl = null;
        this._backlights = {};
        this._bluetooth = null;
        this._profiles = null;
        this._platformProfiles = null;
        this._profileSelection = null;
        this._upower = null;
        this.menuManager = null;
        this.menu = null;
        this._menuPresenter = null;
        this._hotkeys = null;
        this._actorSignalIds = [];
        this._iconTheme = null;
        this._iconThemeId = 0;
        this._monitorsId = 0;
        this._monitors = null;
        this._failures = new Log.FailureLog();

        try {
            this._initialize(metadata, orientation, instanceId, backends);
        } catch (error) {
            this._teardown();
            throw error;
        }
    }

    /*
     * Construction, in the order the order matters in.
     *
     * Five steps, each named for what it is responsible for having finished.
     * They are not independent and must not be reordered: the state a backend
     * can answer into exists before any backend is built, every backend exists
     * before the shell is wired to it, and nothing is asked to draw itself
     * until both are done. A failure at any point leaves _teardown a partial
     * applet to take apart, which is what the constructor hands it.
     */
    _initialize(metadata, orientation, instanceId, backends) {
        this._adoptEnvironment(metadata, instanceId, backends);
        this._buildState();
        this._bindSettings();
        this._buildBackends();
        this._wireToShell(orientation);
        this._begin();
    }

    /* What this applet was handed, and what it tells the panel about itself. */
    _adoptEnvironment(metadata, instanceId, backends) {
        this.metadata = metadata;
        this.instanceId = instanceId;
        this._backends = backends || defaultBackends();
        this._notifications = this._backends.notifications
            ? this._backends.notifications()
            : new Notifications.NotificationCenter(Main);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_show_label_in_vertical_panels(false);
    }

    /*
     * Everything that can answer before there is anything to answer to.
     *
     * A backend can call back from inside its own constructor - a bus it
     * cannot reach, a control that already knows it is absent - so every
     * counter, flag and policy those callbacks touch exists first.
     */
    _buildState() {
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
        /* The wheel counts, and the count is applied once it settles - see
         * lib/scroll-gatherer.js for why a flick is one write and not five.
         * What to do with the settled count is decided when it settles, so
         * the gatherer is handed the notches and the handler the action. */
        this._scroll = new ScrollGatherer.ScrollGatherer({
            settleMs: Controls.SCROLL_SETTLE_MS,
            timers: {
                add: (delay, callback) => Mainloop.timeout_add(delay, callback),
                remove: id => Mainloop.source_remove(id),
            },
            apply: steps => {
                if (this._scrollApply)
                    this._scrollApply(steps);
            },
        });
        this._scrollApply = null;
        /* When a monitor on a cable is worth looking for, and how often - the
         * setting, the built-in panel, the lid and the reasons somebody is
         * looking at the applet, all in lib/monitor-watch.js. What that cannot
         * do without a shell stays here: spawning the probe, and starting or
         * stopping the control that does it. */
        this._monitors = new MonitorWatch.MonitorWatch({
            enabled: () => this.monitorBrightness,
            onProbe: () => this._backlights.monitor.redetect(),
            onScopeChanged: wanted => {
                if (wanted)
                    this._backlights.monitor.start();
                else
                    this._backlights.monitor.stop();
            },
            timers: {
                add: (seconds, callback) =>
                    Mainloop.timeout_add_seconds(seconds, callback),
                remove: id => Mainloop.source_remove(id),
            },
        });
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
            return urgent
                ? this._notifications.critical(title, body)
                : this._notifications.notify(title, body);
        });
        /* A hover gets one prefetch so a later menu is ready; only an open
         * menu keeps probing. The tooltip itself names no monitor. */
        this._panel = new Panel.PanelPresenter(this, metadata.path + "/icons",
                                         shown => this._onTooltipChanged(shown));
        /* A shortcut the manager refuses is somebody else's already, and the
         * only thing to do about it is say so. lib/input.js reports the
         * conflict; the tray to say it in is the applet's. */
        this._hotkeys = new Input.Hotkeys(Main.keybindingManager, accelerator => {
            this._notifications.error(
                _("Power Toys"), Translate.interpolate(
                    _("Shortcut is already in use: %{shortcut}"),
                    { shortcut: accelerator }));
        });
        this._normalizingAlertLevels = false;

    }

    /* The machine, in the order the callbacks between them require. */
    _buildBackends() {

        this._helper = this._backends.privilegedHelper([SYSTEM_HELPER]);

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
            this._profileSelection?.choose();
            this._scheduleUpdate();
        });
        this._platformProfiles = this._backends.platformProfileClient(
            (args, onDone) => this._runHelperQuietly(args, onDone), () => {
                this._profileSelection?.choose();
                this._scheduleUpdate();
            });
        /* Which of the two answers, and the generation that tells one
         * adoption of the same daemon from the next; both clients exist by
         * now, and a client that answers from inside its own constructor
         * finds no selection to move rather than a half-built one. */
        this._profileSelection = new ProfileSelection.ProfileSelection(
            this._profiles, this._platformProfiles,
            /* A request belongs to the writer that accepted it. Its late
             * answer is still allowed to settle, but it must not remain
             * presented after ownership moved. */
            () => this._pending.forget());
        this._profileSelection.choose();
        if (typeof this._platformProfiles.refresh === "function")
            this._platformProfiles.refresh();
        this._upower = this._backends.upowerMonitor(() => this._onUPowerChanged(),
                                                    () => this._onUPowerChanged());
        /* A stubbed backend can answer inside its own constructor, before the
         * assignment above exists. Read it once after assignment as well. */
        this._syncLidState();

    }

    /* The shell: a menu, the actor's own events, and the two desktop-wide
     * changes that invalidate what this applet found. */
    _wireToShell(orientation) {
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

    }

    /* Only now does anything draw, poll or say anything. */
    _begin() {
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
                this._monitors.syncScope();
                this._onBacklightChanged();
                this._update();
            },
            hotkeys: () => this._registerHotkeys(),
            alertLevels: () => this._onAlertLevelsChanged(),
        };

        for (let setting of SettingsTable.SETTINGS) {
            let handler = handlers[SettingsTable.changeGroup(setting)];
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

        /* Once, on Cinnamon 6.6.9, the shell call ended the constructor with
         * "right-hand side of 'in' should be an object, got undefined" and
         * the applet never reached the panel - no icon, and nothing to go on
         * but a stack in the shell log naming a greeting. The notification
         * boundary now contains that shell failure and reports whether the
         * greeting was delivered before it is remembered.
         */
        if (this._notifications.notify(
                _("Power Toys"),
                _("Power profiles, processor settings, batteries and sensors " +
                  "are in this menu. The wheel over the icon changes screen " +
                  "brightness, a middle click toggles the keyboard backlight. " +
                  "Right click to configure those, and to set shortcuts."))) {
            try {
                this.settings.setValue("introduced", true);
            } catch (error) {
                Log.error("could not remember the first-run notification: " + error);
            }
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
         * error, and the menu retries an unavailable control when it opens, so
         * cinnamon-settings-daemon being restarted is enough to make a laptop
         * with a perfectly good backlight temporarily say it has none. Read as
         * "does this machine have a backlight of its own" - which is what
         * decides whether to go anywhere near the I2C bus - that answer is
         * wrong, and it is wrong in the expensive direction: redetect() starts
         * a control that was never started, so the applet would begin spawning
         * ddcutil across the buses of a machine that was deliberately kept off
         * them, and grow sliders for whatever answered.
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
        this._monitors.setKernelBacklightState(control.hardwareState ||
            (control.available ? "present" : "absent"));
        this._monitors.syncScope();
        this._onBacklightChanged();
    }

    _onScreenBacklightChanged() {
        let control = this._backlights.screen;
        let state = control.hardwareState ||
            (control.available ? "present" : "absent");
        if (this._monitors.setKernelBacklightState(state))
            this._monitors.syncScope();
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
        if (!this._monitors.setLidClosed(this._upower?.lidIsClosed))
            return;
        this._monitors.syncScope();
        this._onBacklightChanged();
    }

    /* Whether the built-in panel is present but hidden, which decides which
     * slider the menu draws and which control the wheel moves. Teardown lets
     * go of the watch, and a callback that arrives after it may still ask. */
    _externalDisplayMode() {
        return this._monitors ? this._monitors.externalDisplayMode : false;
    }

    /*
     * A monitor has been plugged in, unplugged or rearranged.
     *
     * The desktop knows this and says so, which is the cheapest moment there
     * is to look again. It is not the only one - the watch also looks while
     * somebody has the menu open - because it only fires for a connector
     * changing, and a monitor that was asleep, switched on without a hotplug
     * event or slow to answer produces none.
     */
    _onMonitorsChanged() {
        if (this._destroyed)
            return;
        this._monitors.probeNow();
    }

    _onTooltipChanged(shown) {
        this._monitors.watch("tooltip", shown);
        /* beforeTooltip paints the cached reading synchronously; this replaces
         * its moving CPU fields as soon as the asynchronous sample answers. */
        if (shown)
            this._update();
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
        let missing = SettingsTable.unboundKeys(this);
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
        let carry = SettingsTable.temperatureLimitCarry(previous, this);
        if (carry)
            this.settings.setValue(carry.key, carry.value);
        this._onSettingsChanged();
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
            /* External monitors are not signal-backed, so the menu owns a
             * separate bounded topology probe: up while open, down when shut.
             * Kernel backlights use their daemon's Changed signal and are
             * retried independently by _onMenuOpened only when unavailable. */
            this._monitors.watch("menu", open);
        });

        this._menuPresenter = new Menu.MenuPresenter(this.menu, this._menuActions(),
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
        let helperBusy = this._helper.busy;
        let profilePrivileged = this.enablePrivilegedControls &&
            (!this._profileSelection.isPlatform || !helperBusy);
        return {
            tempUnit: this.tempUnit,
            showProfiles: this.showProfiles,
            showDevices: this.showDevices,
            showCpu: this.showCpu,
            showSensors: this.showSensors,
            showAllSensors: this.showAllSensors,
            privileged: this.enablePrivilegedControls,
            profilePrivileged: profilePrivileged,
            highTempCelsius: SettingsTable.highTempCelsius(this),
            /* what a device row colours itself against */
            lowLevel: this.lowBatteryThreshold,
            peripheralLevel: this.peripheralBatteryThreshold,
            sensorHint: (this.cpuSensorHint || "").trim(),
            /* a change the machine has not confirmed yet */
            pendingProfile: this._pending.value,
            externalDisplayMode: this._externalDisplayMode(),
            busy: helperBusy,
        };
    }

    _destroyMenu() {
        if (!this.menu)
            return;
        /* An orientation change throws the menu away wholesale, and a menu
         * that is gone never says it shut. */
        this._monitors.watch("menu", false);
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
     * one. The caller has an in-flight flag riding on that promise.
     *
     * The waiting and the assembly are lib/collection.js; what is here is the
     * parts this applet has to offer it and the two reasons a finished
     * collection is still thrown away. */
    _collect(onDone, sampleCpu) {
        let readings = null;
        let profileBackend = this._profileSelection.backend;
        let profileGeneration = this._profileSelection.generation;

        let parts = [done => this._sensors.readAsync(this._sensorFilter(), answer => {
            readings = answer;
            done();
        })];
        if (sampleCpu !== false)
            parts.push(done => this._cpu.sample(done));
        if (this.menu?.isOpen && typeof this._chargeControl?.sample === "function")
            parts.push(done => this._chargeControl.sample(done));
        if (profileBackend && typeof profileBackend.sample === "function")
            parts.push(done => profileBackend.sample(done));

        Collection.gather(parts, () => {
            /* Teardown destroys the backends after a read has started. A
             * backend still settles its callback so the collection can let
             * go, but there is no machine left to assemble for this applet. */
            if (this._destroyed) {
                onDone(null);
                return;
            }
            /* A backend owner change schedules another collection. Do not
             * publish a snapshot assembled from the old backend in between:
             * its controls would belong to a writer that no longer owns it. */
            if (!this._profileSelection.stillOwned(profileBackend, profileGeneration)) {
                onDone(null);
                return;
            }
            let data = null;
            try {
                data = this._assemble(
                    readings,
                    this._profileSelection.snapshot(profileBackend, profileGeneration));
                this._failures.recover("collection");
            } catch (error) {
                this._failures.report("collection", "collection failed: " + error);
            }
            onDone(data);
        });
    }

    /*
     * What this applet has read, handed to the assembly.
     *
     * The other backends answer from memory. UPower and the profile daemon
     * keep their proxies current; processor and sensor nodes were loaded
     * concurrently off the main loop and arrive here as coherent snapshots.
     */
    _assemble(readings, profile) {
        return Collection.assemble({
            readings: readings,
            profile: profile,
            upower: this._upower.read(),
            bluetooth: this._bluetooth,
            cpu: this._cpu.snapshot(),
            charge: this._readChargeLimit(),
            sensorHint: this.cpuSensorHint,
        });
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
     * The runtime backend performs that listing asynchronously and keeps the
     * prior complete topology until the replacement has also sampled every
     * threshold. The group in the menu follows that cached reading, so an
     * answer that changes is drawn either way without blocking Cinnamon.
     */
    _rediscoverChargeControl() {
        if (!this._chargeControl) {
            this._chargeControl = this._backends.chargeControl(
                (args, onDone) => this._runHelper(args, onDone),
                () => this._scheduleUpdate());
        }
        if (this._chargeControl && typeof this._chargeControl.refresh === "function")
            this._chargeControl.refresh();
    }

    /*
     * The charge limit, read only when it could be looked at.
     *
     * The firmware and other tools change it too, so the asynchronous
     * collector samples it whenever the device panel is open. With the menu
     * shut there is nobody it could answer, and the cached value is omitted.
     *
     * Opening the menu starts a fresh collection. _adoptChargeLimit fills its
     * first paint from the last complete cache rather than opening sysfs in
     * the menu signal; the fresh asynchronous value replaces it shortly after.
     */
    _readChargeLimit() {
        /* Whether there is a control at all is a fact about the machine and is
         * reported whatever the menu is doing; the value is what costs a read
         * and is only worth taking while somebody could be looking at it. */
        let available = !!this._chargeControl && this._chargeControl.available;
        if (!available)
            return { available: available, limit: null, state: null, divided: false };
        if (!this.menu?.isOpen)
            return { available: available, limit: null, state: null, divided: false };
        return { available: true, ...this._chargeControl.reading() };
    }

    /* Governor, energy preference, boost and current frequency are useful
     * only in the menu and tooltip. Static CPU topology stays in every
     * reading, but these live sysfs nodes are sampled only for a consumer that
     * can display them. */
    _cpuSampleWanted() {
        let menuUsesCpu = this.menu?.isOpen &&
                          (this.showCpu || this.showSensors);
        return !!menuUsesCpu ||
               !!this._panel?.tooltipNeedsFreshData;
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
                  this.menu?.isOpen;
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
     * These are discovery: which sensors and CPU policies exist, which
     * batteries take a charge limit, and which backend owns the profiles. None
     * changes on the cadence a reading does, so they are asked together on the
     * slow timer and when the menu opens - the two moments the applet already
     * looks at the machine again rather than at its values.
     */
    _rediscover() {
        this._sensors.refresh();
        this._cpu.refresh();
        this._rediscoverChargeControl();
        if (this._platformProfiles && typeof this._platformProfiles.refresh === "function")
            this._platformProfiles.refresh();
        this._profileSelection.choose();
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
        /* How much room the menu has is not known when it is built: the applet
         * can be dragged to another panel on another monitor, the desktop can
         * be rescaled, and the text scaling can be turned up, all without the
         * menu being rebuilt. Asked here because this is the moment before it
         * is shown. */
        this._menuPresenter.syncLayout(this._menuConstraints());
        /* Cheap, and only sweeps again if something moved. The poll does this
         * too, on a much slower cadence; here it is because someone opening
         * the menu wants what is true now. */
        this._rediscover();
        this._sinceRediscover = 0;
        /* Screen and keyboard brightness arrive through Changed, just as
         * battery properties arrive through UPower signals, so their cached
         * values are already current. Retry only a control which has no valid
         * value; this lets a transient daemon failure heal without issuing two
         * unnecessary D-Bus reads on every menu open. External monitors have
         * their own DDC topology probe in the monitor watch. */
        for (let name of ["screen", "keyboard"]) {
            let control = this._backlights[name];
            if (control && !control.available)
                control.refresh(() => this._onBacklightChanged());
        }

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

    /* The room the menu has, and what the desktop is magnifying it by. The
     * derivation and its fallbacks are lib/shell-metrics.js; the shell
     * interfaces it reads are this applet's to hand over. */
    _menuConstraints() {
        return ShellMetrics.menuConstraints({
            layout: Main.layoutManager,
            actor: this.actor,
            global: typeof global !== "undefined" ? global : null,
            st: St,
            gio: Gio,
        });
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
     * This is a cache read only. The menu-open collection performs the actual
     * filesystem sample away from the compositor thread.
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
                    this._failures.recover("reading-presentation");
                } catch (error) {
                    this._failures.report(
                        "reading-presentation", "could not show the reading: " + error);
                }
            }
            if (this._collectAgain) {
                this._collectAgain = false;
                this._update();
            }
        };

        this._collecting = true;
        try {
            this._collect(finished, this._cpuSampleWanted());
            this._failures.recover("reading-start");
        } catch (error) {
            /* Thrown before the read was even started, so nothing is coming. */
            this._failures.report(
                "reading-start", "could not start a reading: " + error);
            finished(null);
        }
    }

    _present(data) {
        this._latest = data;
        let present = (consumer, callback) => {
            let key = "consumer:" + consumer;
            try {
                callback();
                this._failures.recover(key);
            } catch (error) {
                this._failures.report(key, consumer + " failed: " + error);
            }
        };

        /* Caught up with what was asked for - or given long enough to and
         * not, in which case the machine is taken at its word. */
        present("pending profile presentation", () =>
            this._pending.settle(data.profile.active));

        present("panel presentation", () =>
            this._panel.update(data, this._panelOptions()));

        /*
         * The panel is always on screen; the menu usually is not. Composing
         * rows nobody can see costs a formatted string per row per poll, and
         * through the lazily read frequency a file per cpufreq policy as
         * well. The menu is brought up to date when it opens, which is the
         * only moment its contents can be looked at.
         */
        if (this._menuPresenter && this.menu?.isOpen)
            present("menu presentation", () =>
                this._menuPresenter.update(data, this._menuOptions()));

        present("alert policy", () =>
            this._alerts.check(data, this._alertLimits()));
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
            let wanted = PanelText.migratedPanelText(
                SettingsTable.panelSwitches(this));
            if (wanted !== this.panelText)
                this.settings.setValue("panel-text", wanted);
        }
        this.settings.setValue("panel-text-migrated", true);
    }

    _panelOptions() {
        return SettingsTable.panelOptions(this, this._pending.value);
    }

    _alertLimits() {
        return SettingsTable.alertLimits(this);
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
    _setProfile(name, onResult) {
        let state = this._profileState();
        if (!state)
            return false;
        let backend = state.source;
        let generation = state.generation;
        let shown = Reading.shownProfile(this._latest,
                                         { pendingProfile: this._pending.value });
        if (name === shown)
            return false;
        let accepted = this._pending.request(name,
            done => backend.setProfile(name, done), (outcome, matching) => {
                /* Ownership moved while the old transport was in flight.
                 * Its result describes neither the current controls nor the
                 * current writer, and the selection has already cleared
                 * its optimistic presentation. */
                if (!this._profileSelection.stillOwned(backend, generation)) {
                    this._scheduleUpdate();
                    return;
                }
                let error = Profiles.profileWriteError(outcome);
                if (error) {
                    /* Cancelling a password dialog is not news; the user did it. */
                    if (error.message !== "cancelled")
                        this._notifyProfileError(name, error);
                }
                if (matching && onResult)
                    onResult(error);
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
        if (this.menu?.isOpen)
            this.menu.close(false);
    }

    /*
     * The spine both privileged callers share.
     *
     * The privileged-controls gate answered in one sentence, the menu closed
     * for the password dialog, the helper run, and - if the applet is still
     * alive when it answers - the stale-helper warning, a CPU re-read and a
     * redraw. What an outcome is worth telling the user is the caller's, and
     * only the caller's: `handlers.report` turns an outcome into the one
     * `onDone` receives, and `handlers.accepted` runs once the gate has
     * passed and before the dialog. Both are optional.
     *
     * `onDone` is optional and is answered exactly once either way, including
     * when the gate refuses. lib/backlight.js and lib/ddc.js pay for the same
     * guarantee on the other side of the applet: a caller that waits on a call
     * which never answers waits for ever, and "nobody waits on this one today"
     * is a fact about today's callers rather than about this method.
     */
    _callHelper(args, handlers, onDone) {
        handlers = handlers || {};
        let settle = outcome => {
            if (onDone)
                onDone(outcome);
        };

        if (!this.enablePrivilegedControls) {
            settle(HelperMessages.disabledOutcome());
            return;
        }

        if (handlers.accepted)
            handlers.accepted();
        this._closeMenuForAuthentication();

        this._helper.run(args, outcome => {
            if (this._destroyed)
                return;
            this._reportHelperWarning(outcome);
            this._cpu.refresh();
            this._update();
            settle(handlers.report ? handlers.report(outcome) : outcome);
        });
    }

    /*
     * The helper without the notification policy, for a caller that reports
     * the outcome in its own words - a profile that will not switch is not
     * the same news as a governor that will not.
     */
    _runHelperQuietly(args, onDone) {
        this._callHelper(args, {
            report: outcome => HelperMessages.describedOutcome(outcome),
        }, onDone);
    }

    /* An outdated helper is worth saying beside a change that worked, because
     * a warning that only fired on failure would never be seen on the machine
     * it is about. What to say is lib/helper-messages.js; the tray is here. */
    _reportHelperWarning(outcome) {
        let message = HelperMessages.warningMessage(outcome);
        if (message)
            this._notifications.error(_("Power Toys"), message);
    }

    _notifyProfileError(name, error) {
        this._notifications.error(
            _("Power Toys"), HelperMessages.profileErrorMessage(name, error));
    }

    /*
     * A profile block the applet is currently allowed to change. The daemon
     * is unprivileged; the ACPI fallback follows the privileged-control
     * setting, so wheel, middle click and hotkey stop at the same gate as the
     * menu segment.
     */
    _profileState() {
        return ProfileView.steppableState(this._latest, this._profileContext());
    }

    /* What the applet knows about the profile control that the reading does
     * not: who it is talking to, whether that writer is the ACPI platform
     * profile, whether a password dialog is already up for it, and whether
     * privileged changes are allowed at all. */
    _profileContext() {
        return {
            backend: this._profileSelection.backend,
            generation: this._profileSelection.generation,
            platformProfiles: this._platformProfiles,
            busy: !!this._helper?.busy,
            privileged: this.enablePrivilegedControls,
        };
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

        /* Acceptance means a write is in progress, not that it happened.
         * Announce only when this exact request answers successfully; the
         * pending panel state is the feedback while it is in flight. */
        if (!this._setProfile(name, error => {
            if (announce && !error)
                this._notifications.notify(
                    _("Power Toys"),
                    Translate.interpolate(_("Power profile: %{profile}"),
                        { profile: Format.profileLabel(name) }));
        }))
            return false;
        return true;
    }

    _cycleProfile() {
        this._stepProfile(1, true, true);
    }

    /*
     * Governor, energy preference, boost and charge limit are root owned, so
     * they go through a small validating helper launched with pkexec.
     *
     * The gate is in _callHelper rather than inside the helper: whether the
     * user has allowed these changes at all is a setting, and a setting is the
     * applet's business. What the helper answers is turned into a notification
     * here, because deciding what is worth interrupting somebody for is not
     * something a library should do.
     */
    _runHelper(args, onDone) {
        this._callHelper(args, {
            /* So the menu shows the change as in flight straight away rather
             * than when the helper answers. */
            accepted: () => this._scheduleUpdate(),
            report: outcome => {
                if (outcome.applied) {
                    /*
                     * A privileged change ends with a password dialog and
                     * then, until now, nothing - so the last thing that
                     * happened was being asked for a password, and whether it
                     * worked had to be inferred from the menu reading
                     * differently next time it was opened. Say what changed.
                     *
                     * Power profiles are not confirmed this way and do not
                     * need to be: the panel icon is green, yellow or red, and
                     * it changes colour as they take effect.
                     */
                    let changed = Reading.describeChange(args);
                    if (changed)
                        this._notifications.notify(_("Power Toys"), changed);
                } else if (!outcome.cancelled) {
                    /* Cancelled means the user closed the dialog or the
                     * password did not check out; they do not need telling
                     * what they just did. */
                    this._notifications.error(
                        _("Power Toys"), HelperMessages.errorMessage(outcome));
                }
                return outcome;
            },
        }, onDone);
    }

    /*
     * The wheel counts, and the count is applied once it settles.
     *
     * Three clicks in one direction means three steps, clamped at the ends -
     * the wheel should stop at performance rather than come round again at
     * power saver - and it reaches the daemon as one write instead of three.
     */
    _onScroll(actor, event) {
        let amount = Controls.scrollAmount(event);
        if (amount === 0)
            return Clutter.EVENT_PROPAGATE;

        /* Which of the two the setting asks for, and whether this machine can
         * do it, is lib/input.js. The brightness notch is the control's own,
         * so on a kernel backlight this moves by the same amount the
         * brightness keys do; the profile step is announced, because the panel
         * is not necessarily showing the profile and otherwise nothing would
         * say it had changed. */
        switch (Input.wheelAction(this.scrollAction, this._inputCapabilities())) {
            case "brightness":
                this._gatherScroll(amount, notches => this._stepBrightness(notches));
                return Clutter.EVENT_STOP;
            case "profile":
                this._gatherScroll(amount,
                                   notches => this._stepProfile(notches, false, true));
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    /* What this machine can actually be asked to do with a wheel or a middle
     * click, at this moment: a monitor can be unplugged and a profile daemon
     * can go away while the applet is on the panel. */
    _inputCapabilities() {
        return {
            brightness: !!this._brightnessControl(),
            keyboardBacklight: !!(this._backlights.keyboard &&
                                  this._backlights.keyboard.available),
            profile: !!this._profileState(),
        };
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

    /* Middle click. The stock applet toggles the keyboard backlight, which is
     * the sort of thing nobody discovers but everybody who knew about it
     * misses; what the setting means is lib/input.js. */
    _onButtonPress(actor, event) {
        if (event.get_button() !== 2)
            return Clutter.EVENT_PROPAGATE;

        switch (Input.middleClickAction(this.middleClickAction,
                                        this._inputCapabilities())) {
            case "keyboard-backlight":
                this._backlights.keyboard.toggle(() => this._onBacklightChanged());
                return Clutter.EVENT_STOP;
            case "profile":
                this._cycleProfile();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _gatherScroll(step, apply) {
        this._scrollApply = apply;
        this._scroll.gather(step);
    }

    _cancelPendingScroll() {
        this._scroll.cancel();
        this._scrollApply = null;
    }

    /* The two accelerators, named per applet instance so two copies on the
     * panel do not fight over one keybinding name. */
    _registerHotkeys() {
        this._hotkeys.apply([
            {
                name: UUID + "-cycle-profile-" + this.instanceId,
                accelerator: this.cycleProfileHotkey,
                action: () => this._cycleProfile(),
            },
            {
                name: UUID + "-toggle-menu-" + this.instanceId,
                accelerator: this.toggleMenuHotkey,
                action: () => this.menu.toggle(),
            },
        ]);
    }

    /* ------------------------------------------------------------------ */
    /* applet lifecycle                                                    */

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    /* Moving the applet to a vertical panel rebuilds the icon actor as well as
     * the menu, and the cache in PanelPresenter keys on what the icon should
     * be rather than on the actor holding it - so the redraw below would find
     * the key unchanged, skip the icon, and leave the new actor empty until
     * something else changed the icon. The invalidation contract names this
     * caller; it was the one caller that did not honour it. */
    on_orientation_changed(orientation) {
        this._destroyMenu();
        this._createMenu(orientation);
        this._panel.invalidateIcon();
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
        release("monitor watch", () => this._monitors?.destroy());
        release("scroll timer", () => this._cancelPendingScroll());
        if (this._idleId) {
            let id = this._idleId;
            this._idleId = 0;
            release("update callback", () => Mainloop.source_remove(id));
        }
        release("hotkeys", () => {
            if (this._hotkeys)
                this._hotkeys.release();
        });

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
        this._profileSelection?.release();
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
        destroy("_chargeControl", "charge-limit backend");
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
