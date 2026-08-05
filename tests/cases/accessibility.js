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
