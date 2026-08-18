/*
 * cinnamon-powertoys - the menu.
 *
 * Everything inside the popup: the columns it is laid out in, the sections
 * that stop those columns aligning with each other, and the presenter that
 * builds every group once and then does nothing but hand each update to the
 * rows and controls that are already there.
 *
 * It reads no backend and calls none. What the user does arrives as the
 * callbacks it was constructed with, and what to show arrives as one reading
 * and one set of options per update.
 *
 * Cinnamon widgets, so see the note in ui/rows.js about why this is not a
 * library.
 */

const PopupMenu = imports.ui.popupMenu;

const Device = require("./lib/device.js");
const Format = require("./lib/format.js");
const KeyedList = require("./lib/keyed-list.js");
const PanelText = require("./lib/panel-text.js");
const ProfileView = require("./lib/profile-view.js");
const Reading = require("./lib/reading.js");
const SensorRows = require("./lib/sensor-rows.js");
const Translate = require("./lib/gettext.js");
const Controls = require("./ui/controls.js");
const Rows = require("./ui/rows.js");

const _ = Translate._;

const BacklightSlider = Controls.BacklightSlider;
const ChoiceControl = Controls.ChoiceControl;
const SegmentedControl = Controls.SegmentedControl;
const DeviceRow = Rows.DeviceRow;
const InfoRow = Rows.InfoRow;
const NoteRow = Rows.NoteRow;
const exposeHeading = Rows.exposeHeading;

/* Charge limits offered in the menu, in percent. */
const CHARGE_LIMITS = [60, 70, 80, 90, 95, 100];

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
    exposeHeading(heading, text);
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
        if (options?.spaced)
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

        this._holdsRow = new InfoRow(_("Profile holds"), "");
        this._holdsRow.actor.hide();
        this._profileGroup.menu.addMenuItem(this._holdsRow);
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
        this._noDevicesRow = new InfoRow("", "");
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
            menu, _("Charge limit"), limit => Format.percent(limit),
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
     * A monitor past the tenth gets a line saying so beside the sliders that
     * can actually be presented. The note cannot stand alone: detection can
     * find more than ten displays while every one probed for brightness fails,
     * and a Brightness group containing only a limit note offers no control.
     */
    _syncMonitors() {
        if (!this._monitors)
            return;

        let entries = this._monitors.monitors
            .filter(monitor => monitor.available)
            .map(monitor => ({ key: "monitor:" + monitor.id, label: monitor.name,
                               control: monitor }));

        if (entries.length > 0 && this._monitors.hidden > 0)
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
        exposeHeading(heading, text);
        heading.actor.add_style_class_name("powertoys-subgroup-title");
        heading.label.add_style_class_name("powertoys-subgroup-title-text");
        heading.setLabel = value => {
            heading.label.set_text(value || "");
            heading.actor.set_accessible_name(value || "");
        };
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
            let kind = Format.deviceKindName(data.primary.kind);
            let charge = Format.batteryReading(data.primary).text;
            this._summary.setLabel(charge ? Translate.interpolate(
                _("%{kind} %{charge}"), { kind: kind, charge: charge }) : kind);
            let detail = Format.deviceStateName(data.primary.state);
            let remaining = Device.remainingText(data.primary);
            if (remaining)
                detail = Translate.interpolate(
                    _("%{state} · %{remaining}"), { state: detail, remaining: remaining });
            this._summary.setValue(detail);
        } else {
            this._summary.setLabel(PanelText.powerStatusLabel(data));
            this._summary.setValue("");
        }
    }

    /* What to show is lib/profile-view.js; what is left here is the showing. */
    _updateProfiles(data, options) {
        let view = ProfileView.menuView(data, options);

        this._profileGroup.setVisible(view.show);
        this._profileControl.sync(view.choices, view.active, view.editable);
        this._profileControl.actor.visible = view.showChoices;
        this._profileValueRow.setValue(view.valueText);
        this._profileValueRow.actor.visible = view.single;
        this._showRow(this._degradedRow, view.degradedText);
        this._showRow(this._holdsRow, view.holdsText);
    }

    /* A row with something to say, or no row. */
    _showRow(row, text) {
        if (text) {
            row.setValue(text);
            row.actor.show();
        } else {
            row.actor.hide();
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
        let emptyStatus = Device.emptyStatus(data);
        this._noDevicesRow.setLabel(emptyStatus);
        this._noDevicesRow.actor.visible = emptyStatus !== "";
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
            this._hintRow.setLabel(Translate.interpolate(
                _("No sensor matches \u201c%{sensor}\u201d"), { sensor: options.sensorHint }));

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
