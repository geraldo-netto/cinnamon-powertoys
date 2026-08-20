/*
 * cinnamon-powertoys - the menu's rows.
 *
 * One row of a popup menu each: a reading, a note about the rows around it, a
 * powered device, one choice of a radio group. They take text or a view model
 * and set it; none of them reads the applet, a backend or a setting.
 *
 * Everything under ui/ builds Cinnamon widgets and therefore cannot be loaded
 * outside the shell, which is why it is not under lib/: what is in lib/ is
 * loaded, measured and mutated by the test suite, and a module that cannot be
 * loaded there would quietly count as untested code. These are held to by the
 * parse check and by the source-level cases in tests/cases/accessibility.js.
 */

const Atk = imports.gi.Atk;
const Pango = imports.gi.Pango;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const Format = require("./lib/format.js");

/* A non reactive "label ......... value" line. */
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init(label, value) {
        super._init.call(this, { reactive: false });

        this._labelText = label || "";
        this._valueText = value || "";
        this._label = new St.Label({ text: label, style_class: "powertoys-info-label" });
        this._value = new St.Label({ text: value || "", style_class: "powertoys-info-value" });

        this.addActor(this._label);
        this.addActor(this._value, { expand: true, span: -1, align: St.Align.END });
        this._syncAccessibleName();
    }

    setLabel(text) {
        this._labelText = text || "";
        this._label.set_text(this._labelText);
        this._syncAccessibleName();
    }

    setValue(text) {
        this._valueText = text || "";
        this._value.set_text(this._valueText);
        this._syncAccessibleName();
    }

    _syncAccessibleName() {
        this.actor.set_accessible_name(
            Format.readingName(this._labelText, this._valueText));
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
        /* The child alone receives pointer events for the tooltip. The row
         * remains non-reactive and cannot become a menu action or keyboard
         * stop merely because its complete sentence is available on hover. */
        this._label = new St.Label({ text: text, reactive: true, track_hover: true });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.add_style_class_name("powertoys-note-text");
        this.addActor(this._label, { span: -1, expand: true });
        this.tooltip = new Tooltips.Tooltip(this._label, text);
        this.actor.set_accessible_name(text || "");
    }

    setText(text = "") {
        this._label.set_text(text);
        this.tooltip.set_text(text);
        this.actor.set_accessible_name(text);
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
        /* Title and details are two labels inside a box inside a non-reactive
         * row, so without this the whole entry is an unnamed menu item and the
         * charge, the time remaining and the limit below it are unreachable. */
        this.actor.set_accessible_name(
            Format.readingName(model.title, model.details));

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
        this._selected = selected === true;
        this.actor.set_accessible_role(Atk.Role.RADIO_MENU_ITEM);
        this._syncSelection();
        this.connect("activate", () => {
            if (!this._selected)
                onActivate(value);
        });
    }

    setSelected(selected) {
        this._selected = selected === true;
        this._syncSelection();
    }

    _syncSelection() {
        this.setShowDot(this._selected);
        if (this._selected)
            this.actor.add_accessible_state(Atk.StateType.CHECKED);
        else
            this.actor.remove_accessible_state(Atk.StateType.CHECKED);
    }
}

/* A heading is visible structure rather than an unavailable command. Cinnamon
 * gives every PopupBaseMenuItem a MENU_ITEM role by default, including the
 * non-reactive ones; state the role and name that the typography already
 * communicates without putting the actor into the keyboard focus order. */
function exposeHeading(item, text) {
    item.actor.set_accessible_role(Atk.Role.HEADING);
    item.actor.set_accessible_name(text || "");
}

/*
 * A heading over the rows it names.
 *
 * Not a menu item that does anything, and deliberately not the same weight as
 * the rows it heads: a heading is furniture, and what is read in this menu is
 * the numbers. The size goes on the label and the padding and the opacity on
 * the row; see the stylesheet for what putting both on the row cost.
 *
 * Two of these were written out, one for a group and one for a subgroup inside
 * it, differing in a style class and in whether the text could be changed
 * afterwards - which is a difference between two headings and not between two
 * kinds of thing.
 */
function _heading(text, name, relabel) {
    let heading = new PopupMenu.PopupMenuItem(text, { reactive: false });
    exposeHeading(heading, text);
    heading.actor.add_style_class_name("powertoys-" + name + "-title");
    heading.label.add_style_class_name("powertoys-" + name + "-title-text");
    if (relabel) {
        heading.setLabel = value => {
            heading.label.set_text(value || "");
            heading.actor.set_accessible_name(value || "");
        };
    }
    return heading;
}

/* The heading over one group of rows. */
function headingItem(text) {
    return _heading(text, "group", false);
}

/*
 * A heading inside a group, over some of its rows.
 *
 * These are named from a reading, so unlike a group heading the text changes:
 * which chips a machine has, and what they are called, is not known when the
 * menu is built.
 */
function subheadingItem(text) {
    return _heading(text, "subgroup", true);
}
