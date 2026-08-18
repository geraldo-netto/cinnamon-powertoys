/* The panel icon's cache contract.
 *
 * PanelPresenter._updateIcon does nothing while the key it would set is the
 * key already set, which is what keeps a poll from costing a texture lookup.
 * Anything that changes what a key means, or that rebuilds the actor holding
 * the icon, therefore has to drop the cache before asking for a redraw - and
 * an omission is invisible at runtime except as a panel icon that is blank
 * until something unrelated happens to change it.
 *
 * The applet cannot load outside Cinnamon, so this reads the source, as the
 * other applet-level cases do. Each trigger is checked as a whole method
 * body, so a caller that invalidates after its redraw, or not at all, fails. */

const Harness = imports.harness;

/* One method of the applet class, from its signature to the closing brace at
 * the same indentation. */
function methodBody(source, name) {
    let pattern = new RegExp("\\n    " + name + "\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}\\n");
    let match = pattern.exec(source);
    Harness.ok(match !== null, name + " is present in applet.js");
    return match[1];
}

/* Every reason the cached key stops describing what is on the panel. Each is
 * a method of the applet, and each has to invalidate before it redraws. */
const TRIGGERS = [
    ["on_orientation_changed", "a vertical panel rebuilds the icon actor"],
    ["on_panel_height_changed", "a resize rebuilds the icon actor"],
    ["_onIconThemeChanged", "a theme change moves which icon names exist"],
];

var cases = {};

cases["every rebuild of the icon actor drops the cached key first"] = function () {
    let source = Harness.shellSource();
    for (let [name, why] of TRIGGERS) {
        let body = methodBody(source, name);
        let invalidate = body.indexOf("this._panel.invalidateIcon();");
        let redraw = body.indexOf("this._update();");
        Harness.ok(invalidate >= 0, name + " invalidates the icon: " + why);
        Harness.ok(redraw >= 0, name + " redraws");
        Harness.ok(invalidate < redraw,
                   name + " invalidates before the redraw that would skip the icon");
    }
};

cases["the icon setting drops the cached key before redrawing"] = function () {
    let source = Harness.shellSource();
    let handler = /icon: \(\) => \{([\s\S]*?)\n            \},/.exec(source);
    Harness.ok(handler !== null, "the icon settings handler is present");
    Harness.ok(handler[1].indexOf("this._panel.invalidateIcon();") >= 0,
               "changing what the icon should show drops the key that says it has not changed");
    Harness.ok(handler[1].indexOf("this._panel.invalidateIcon();") <
               handler[1].indexOf("this._update();"),
               "before the redraw");
};

cases["the invalidation contract names every trigger that honours it"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/lib/panel-presenter.js");
    let start = source.indexOf("    invalidateIcon() {");
    Harness.ok(start >= 0, "the cache drop is present");
    /* Comment text wraps, so the phrases are matched against it as prose. */
    let contract = source.slice(source.lastIndexOf("/*", start), start)
        .replace(/\s*\*\s*/g, " ").replace(/\s+/g, " ").toLowerCase();
    for (let phrase of ["orientation change", "panel resize", "icon theme change"])
        Harness.ok(contract.indexOf(phrase) >= 0,
                   "the contract names the " + phrase);
};
