/*
 * Two of the menu's groups, each with everything about it in one place.
 *
 * The presenter in ui/menu.js built six groups, synced six groups and updated
 * six groups, so a change to any one of them was a change to a class the other
 * five also lived in - and the three methods about one group sat a hundred
 * lines apart, in three lists that had to be kept in the same order.
 *
 * A group here builds itself into the column it is handed and updates itself
 * from one reading. It reads no backend and calls none: what the user does is
 * reported through the actions it was constructed with.
 *
 * Cinnamon widgets, so see the note in ui/rows.js about why this is not a
 * library.
 */

const PopupMenu = imports.ui.popupMenu;

const Device = require("./lib/device.js");
const Format = require("./lib/format.js");
const KeyedList = require("./lib/keyed-list.js");
const PanelText = require("./lib/panel-text.js");
const SensorRows = require("./lib/sensor-rows.js");
const Translate = require("./lib/gettext.js");
const Controls = require("./ui/controls.js");
const Rows = require("./ui/rows.js");

const _ = Translate._;

const ChoiceControl = Controls.ChoiceControl;
const DeviceRow = Rows.DeviceRow;
const InfoRow = Rows.InfoRow;
const NoteRow = Rows.NoteRow;

/* The limits the charge control offers. Not every value between 60 and 100:
 * the point of the control is one click, and a spinner would be a number to
 * choose rather than a decision to make. */
const CHARGE_LIMITS = [60, 70, 80, 90, 95, 100];

/*
 * Everything with a charge, and the limit whatever is charging is held to.
 */
class DeviceGroup {
    constructor(column, actions) {
        this._actions = actions;
        this._deviceGroup = column.group(_("Devices"));
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

    update(data, options) {
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

    /* Under the devices heading, so it is beside the battery it applies to
     * rather than being a submenu of its own. */
    updateChargeLimit(data, options) {
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

    /* The column this group is in is only there while something in it is. */
    get visible() {
        return this._deviceGroup.heading.actor.visible;
    }
}

/*
 * What the machine is running on, and what that is doing to the temperature.
 */
class SensorGroup {
    constructor(column) {
        this._sensorGroup = column.group(_("Sensors"));

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
                                             ? Rows.subheadingItem(entry.label)
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
    updateSummary(data, options) {
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

    update(data, options) {
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

    /* The column this group is in is only there while something in it is. */
    get visible() {
        return this._sensorGroup.heading.actor.visible;
    }
}
