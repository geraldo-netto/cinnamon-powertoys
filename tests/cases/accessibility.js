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
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    Harness.ok(source.indexOf("Atk.Object.prototype.set_description.call(") >= 0,
               "the Atk.Object method is selected explicitly");
    Harness.ok(source.indexOf("this._accessible.set_description(") < 0,
               "Atk.Action.set_description needs an action index and text");
};

cases["one power profile is status rather than a control"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    Harness.ok(source.indexOf("this._profileValueRow = new InfoRow") >= 0,
               "a non-reactive value row exists for the single profile");
    Harness.ok(source.indexOf("data.profile.list.length === 1") >= 0,
               "the one-value backend selects that row");
    Harness.ok(source.indexOf("this._profileControl.actor.visible = show && !single") >= 0,
               "the focusable segmented control is removed in that state");
};

cases["selector dots expose synchronized radio semantics"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
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
    let source = Harness.readFile(Harness.xletDir() + "/applet.js");
    let start = source.indexOf("function exposeHeading");
    let helper = source.slice(start, source.indexOf("\n/*", start));
    Harness.ok(start >= 0 && helper.length > 0, "the heading boundary is present");
    Harness.ok(helper.indexOf("set_accessible_role(Atk.Role.HEADING)") >= 0,
               "visual headings identify their structural role");
    Harness.ok(helper.indexOf("set_accessible_name(text || \"\")") >= 0,
               "the role has an explicit name");

    let uses = source.match(/\bexposeHeading\(/g) || [];
    Harness.equal(uses.length, 4,
                  "the helper and all three heading factories use the same boundary");
    Harness.ok(source.indexOf("heading.actor.set_accessible_name(value || \"\")") >= 0,
               "renamed sensor headings synchronize their accessible name");
};
