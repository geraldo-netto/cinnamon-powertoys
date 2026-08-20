/*
 * cinnamon-powertoys - the menu's controls.
 *
 * A control is more than a row: it owns several rows, or a row and the widget
 * that replaces it, and it decides between them from the values it is handed.
 * A radio group, a setting that is a group or a single reading depending on
 * whether it can be changed, the power profile as a row of segments, and a
 * backlight slider.
 *
 * Cinnamon widgets, so see the note in ui/rows.js about why this is not a
 * library.
 */

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const Format = require("./lib/format.js");
const Input = require("./lib/input.js");
const KeyedList = require("./lib/keyed-list.js");
const ScrollGatherer = require("./lib/scroll-gatherer.js");
const Translate = require("./lib/gettext.js");
const Rows = require("./ui/rows.js");

const _ = Translate._;

const InfoRow = Rows.InfoRow;
const NoteRow = Rows.NoteRow;
const SelectorItem = Rows.SelectorItem;
const exposeHeading = Rows.exposeHeading;

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
        exposeHeading(header, this._title);
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
        this._scroll = new ScrollGatherer.ScrollGatherer({
            settleMs: ScrollGatherer.SETTLE_MS,
            apply: steps => this._control.stepBy(steps, () => this.sync()),
        });
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
        this.actor.set_accessible_name(Translate.interpolate(
            _("Brightness: %{display}"), { display: label }));
        this._accessible = this.actor.get_accessible();
        /* Slider accessibles also implement Atk.Action, whose set_description
         * takes an action index before the text. Name Atk.Object explicitly so
         * GJS cannot resolve the colliding interface method. */
        Atk.Object.prototype.set_description.call(
            this._accessible, Translate.interpolate(
                _("Brightness range: %{minimum} to %{maximum}; step: %{step}"), {
                    minimum: Format.percent(0),
                    maximum: Format.percent(100),
                    step: Format.percent(BACKLIGHT_STEP),
                }));

        this.tooltip = new Tooltips.Tooltip(this.actor, label);

        this.connect("drag-begin", () => { this._seeking = true; });
        this.connect("drag-end", () => { this._seeking = false; });
        this.connect("value-changed", (item, value) => this._onDragged(value));
        this.actor.connect("destroy", () => this._scroll.cancel());
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
        this.actor.set_accessible_name(Translate.interpolate(
            _("Brightness: %{display}"), { display: label }));
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
        let percentageText = Format.percent(percentage);
        this._reading.set_text(percentageText);
        this.tooltip.set_text(percentage === null ? this._name : Translate.interpolate(
            _("%{display}: %{percentage}"), {
                display: this._name,
                percentage: percentageText,
            }));
        if (percentage !== null)
            this._accessible.accessible_value = percentage;
    }

    /* The daemon owns the notch size, and it is the one the brightness keys
     * use, so the wheel and the keyboard agree. */
    _onScrollEvent(actor, event) {
        let amount = Input.scrollAmount(event, Clutter.ScrollDirection);
        if (amount === 0)
            return Clutter.EVENT_PROPAGATE;

        this._scroll.gather(amount);
        return Clutter.EVENT_STOP;
    }
}
