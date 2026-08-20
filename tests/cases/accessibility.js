/* Accessibility calls in applet.js that depend on Cinnamon's actor types.
 *
 * The applet itself cannot load outside Cinnamon, so keep the interface
 * collision that once prevented the whole applet from loading covered at the
 * source boundary. A slider's accessible implements Atk.Action as well as
 * Atk.Object; GJS therefore resolves set_description to Atk.Action's
 * two-argument method, not Atk.Object's one-argument method. */

const Harness = imports.harness;

var cases = {};

cases["slider descriptions avoid Atk.Action's method"] = function () {
    let source = Harness.shellSource();
    Harness.ok(source.indexOf("Atk.Object.prototype.set_description.call(") >= 0,
               "the Atk.Object method is selected explicitly");
    Harness.ok(source.indexOf("this._accessible.set_description(") < 0,
               "Atk.Action.set_description needs an action index and text");
};

cases["slider range and step are complete localized accessibility text"] = function () {
    let source = Harness.shellSource();
    let start = source.indexOf("class BacklightSlider ");
    let slider = source.slice(start, source.indexOf("\nclass PanelPresenter", start));
    Harness.ok(start >= 0 && slider.length > 0, "the backlight slider is present");
    Harness.ok(slider.indexOf(
        '_("Brightness range: %{minimum} to %{maximum}; step: %{step}")') >= 0,
        "range and step form one translatable description");
    for (let value of ["0", "100", "BACKLIGHT_STEP"])
        Harness.ok(slider.indexOf("Format.percent(" + value + ")") >= 0,
                   value + " uses the shared localized percentage formatter");
    Harness.equal(slider.indexOf('"0–100% · "'), -1,
                  "the cryptic untranslated fragment is gone");
};

cases["one power profile is status rather than a control"] = function () {
    let source = Harness.shellSource();
    Harness.ok(source.indexOf("this._profileValueRow = new InfoRow") >= 0,
               "a non-reactive value row exists for the single profile");
    /* Which of the two is on screen is decided in lib/profile-view.js, whose
     * own cases check the decision; what is checked here is that the menu
     * honours it and that the two are alternatives rather than both drawn. */
    Harness.ok(source.indexOf("this._profileControl.actor.visible = view.showChoices") >= 0,
               "the focusable segmented control follows the view");
    Harness.ok(source.indexOf("this._profileValueRow.actor.visible = view.single") >= 0,
               "and the value row is shown exactly when there is nothing to choose");
    let view = Harness.readFile(Harness.xletDir() + "/lib/profile-view.js");
    Harness.ok(view.indexOf("profile.list.length === 1") >= 0,
               "the one-value backend is what selects that row");
};

cases["selector dots expose synchronized radio semantics"] = function () {
    let source = Harness.shellSource();
    let start = source.indexOf("class SelectorItem ");
    let selector = source.slice(start, source.indexOf("\nclass SelectorGroup", start));
    Harness.ok(start >= 0 && selector.length > 0, "the selector class is present");
    Harness.ok(selector.indexOf("Atk.Role.RADIO_MENU_ITEM") >= 0,
               "each choice identifies itself as a radio menu item");
    Harness.ok(selector.indexOf("add_accessible_state(Atk.StateType.CHECKED)") >= 0,
               "the selected dot has an accessible checked state");
    Harness.ok(selector.indexOf("remove_accessible_state(Atk.StateType.CHECKED)") >= 0,
               "an unselected dot clears that state");
    Harness.ok(selector.indexOf("setSelected(selected) {\n" +
                                "        this._selected = selected === true;\n" +
                                "        this._syncSelection();") >= 0,
               "runtime selection changes update both representations");
};

cases["visual group titles expose heading semantics"] = function () {
    let source = Harness.shellSource();
    let start = source.indexOf("function exposeHeading");
    let helper = source.slice(start, source.indexOf("\n/*", start));
    Harness.ok(start >= 0 && helper.length > 0, "the heading boundary is present");
    Harness.ok(helper.indexOf("set_accessible_role(Atk.Role.HEADING)") >= 0,
               "visual headings identify their structural role");
    Harness.ok(helper.indexOf("set_accessible_name(text || \"\")") >= 0,
               "the role has an explicit name");

    /* The helper, the one builder both group and subgroup headings are made
     * by, and the radio group's own header. Two of the three builders were the
     * same function written twice. */
    let uses = source.match(/\bexposeHeading\(/g) || [];
    Harness.equal(uses.length, 3,
                  "every heading in the menu goes through the same boundary");
    Harness.ok(source.indexOf("heading.actor.set_accessible_name(value || \"\")") >= 0,
               "renamed sensor headings synchronize their accessible name");
};

cases["clipped notes preserve their complete text"] = function () {
    let source = Harness.shellSource();
    let start = source.indexOf("class NoteRow ");
    let note = source.slice(start, source.indexOf("\nclass DeviceRow", start));
    Harness.ok(start >= 0 && note.length > 0, "the note row is present");
    Harness.ok(note.indexOf("Pango.EllipsizeMode.END") >= 0,
               "clipping is shown with an ellipsis");
    Harness.ok(note.indexOf("new Tooltips.Tooltip(this._label, text)") >= 0,
               "the complete text is available to the pointer");
    Harness.ok(note.indexOf("this.actor.set_accessible_name(text)") >= 0,
               "updated text remains available to assistive technology");
    Harness.ok(note.indexOf("super._init.call(this, { reactive: false })") >= 0,
               "the informational row stays outside the interactive focus order");
};

/*
 * The reading rows name themselves.
 *
 * InfoRow and DeviceRow are non-reactive rows whose text lives in child
 * labels, so without a name of their own each sensor value, the summary, the
 * degraded and holds lines and every device entry reach assistive technology
 * as an unnamed menu item. The sibling widgets - NoteRow, the headings, the
 * sliders, the segment buttons - all say what they are; these did not.
 */
function classBody(source, name, next) {
    let start = source.indexOf("class " + name + " ");
    Harness.ok(start >= 0, name + " is present");
    let end = source.indexOf("\nclass " + next, start);
    Harness.ok(end > start, next + " follows " + name);
    return source.slice(start, end);
}

cases["a reading row names itself from its label and its value"] = function () {
    let source = Harness.shellSource();
    let row = classBody(source, "InfoRow", "NoteRow");
    Harness.ok(row.indexOf("Format.readingName(this._labelText, this._valueText)") >= 0,
               "the name is composed by the shared formatter");
    /* Both setters and the constructor, or a row keeps the name it was born
     * with while its text changes underneath it on every poll. */
    let synced = row.match(/this\._syncAccessibleName\(\);/g) || [];
    Harness.equal(synced.length, 3,
                  "the constructor and both setters keep the name and the text together");
    for (let setter of ["setLabel", "setValue"]) {
        let body = new RegExp(setter + "\\(text\\) \\{([\\s\\S]*?)\\n    \\}").exec(row);
        Harness.ok(body !== null, setter + " is present");
        Harness.ok(body[1].indexOf("this._syncAccessibleName();") >= 0,
                   setter + " updates the name it just invalidated");
    }
};

cases["a device entry names itself from its model"] = function () {
    let source = Harness.shellSource();
    let row = classBody(source, "DeviceRow", "SelectorItem");
    let update = /update\(model\) \{([\s\S]*?)\n    \}/.exec(row);
    Harness.ok(update !== null, "DeviceRow.update is present");
    Harness.ok(update[1].indexOf("Format.readingName(model.title, model.details)") >= 0,
               "title and details are one name rather than two unreachable labels");
    Harness.ok(update[1].indexOf("set_accessible_name") >= 0,
               "and it is set on the row itself, which is what a reader lands on");
};
