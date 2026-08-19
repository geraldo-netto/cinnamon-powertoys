/*
 * What a wheel notch, a middle click and a shortcut mean.
 *
 * These rules used to be inline in applet.js, which cannot be loaded outside
 * Cinnamon - so a wheel over a desktop with no backlight, or a shortcut
 * somebody else already holds, could only be tried by opening a session.
 */

const Harness = imports.harness;

const Input = Harness.requireXlet("./lib/input.js");

function manager(refuse) {
    let state = { added: [], removed: [] };
    state.addHotKey = function (name, accelerator, action) {
        state.added.push({ name: name, accelerator: accelerator, action: action });
        return accelerator !== refuse;
    };
    state.removeHotKey = function (name) {
        state.removed.push(name);
    };
    return state;
}

var cases = {};

cases["the wheel does what the setting asks, where the machine can"] = function () {
    let all = { brightness: true, keyboardBacklight: true, profile: true };
    Harness.equal(Input.wheelAction("brightness", all), "brightness",
                  "brightness is the setting the replaced applet had");
    Harness.equal(Input.wheelAction("profile", all), "profile",
                  "the profile is the other thing a wheel can do");
    Harness.equal(Input.wheelAction("none", all), null,
                  "a wheel nobody asked for is nobody's");
};

cases["a wheel this machine cannot answer falls through"] = function () {
    let none = { brightness: false, keyboardBacklight: false, profile: false };
    Harness.equal(Input.wheelAction("brightness", none), null,
                  "a desktop with no backlight lets the panel have the wheel");
    Harness.equal(Input.wheelAction("profile", none), null,
                  "so does a machine with no profile writer");
    Harness.equal(Input.wheelAction("brightness"), null,
                  "and so does one that was asked before it knew");
};

cases["middle click is its own setting with its own capability"] = function () {
    let keyboardOnly = { brightness: true, keyboardBacklight: true, profile: false };
    Harness.equal(Input.middleClickAction("keyboard-backlight", keyboardOnly),
                  "keyboard-backlight", "the keyboard backlight is there");
    Harness.equal(Input.middleClickAction("profile", keyboardOnly), null,
                  "the profile writer is not, on the same machine");
    Harness.equal(Input.middleClickAction("brightness", keyboardOnly), null,
                  "the wheel's setting is not the middle click's");
    Harness.equal(Input.middleClickAction("keyboard-backlight"), null,
                  "and an unasked machine can do nothing");
};

cases["shortcuts are registered, and an empty one is not a shortcut"] = function () {
    let keys = manager();
    let hotkeys = new Input.Hotkeys(keys);
    hotkeys.apply([
        { name: "cycle", accelerator: "<Super>p", action: function () {} },
        { name: "toggle", accelerator: "", action: function () {} },
        null,
    ]);
    Harness.equal(keys.added.length, 1, "only the accelerator somebody set");
    Harness.equal(keys.added[0].name, "cycle", "and it is the one they set");
    Harness.equal(hotkeys.registered.join(","), "cycle", "which is what is held");
};

cases["a shortcut somebody else holds is reported, not lost"] = function () {
    let keys = manager("<Super>p");
    let refused = [];
    let hotkeys = new Input.Hotkeys(keys, (accelerator, name) => {
        refused.push(name + ":" + accelerator);
    });
    hotkeys.apply([
        { name: "cycle", accelerator: "<Super>p", action: function () {} },
        { name: "toggle", accelerator: "<Super>t", action: function () {} },
    ]);
    Harness.equal(refused.join(","), "cycle:<Super>p", "the conflict is named");
    Harness.equal(hotkeys.registered.join(","), "toggle",
                  "and the one that took is still held");
    hotkeys.release();
    Harness.equal(keys.removed.join(","), "toggle",
                  "a refused registration is not removed on the way out");
};

cases["applying again gives up what it held first"] = function () {
    let keys = manager();
    let hotkeys = new Input.Hotkeys(keys);
    hotkeys.apply([{ name: "cycle", accelerator: "<Super>p", action: function () {} }]);
    hotkeys.apply([{ name: "cycle", accelerator: "<Super>q", action: function () {} }]);
    Harness.equal(keys.removed.join(","), "cycle",
                  "a shortcut that moved stops answering at the old accelerator");
    Harness.equal(keys.added.length, 2, "and is registered again at the new one");
    Harness.equal(keys.added[1].accelerator, "<Super>q", "which is the new one");
};

cases["releasing twice removes once"] = function () {
    let keys = manager();
    let hotkeys = new Input.Hotkeys(keys);
    hotkeys.apply([{ name: "cycle", accelerator: "<Super>p", action: function () {} }]);
    hotkeys.release();
    hotkeys.release();
    Harness.equal(keys.removed.length, 1, "teardown after teardown is not a second one");
    Harness.equal(hotkeys.registered.length, 0, "and nothing is held afterwards");
};

cases["nothing to apply is not an error"] = function () {
    let keys = manager();
    let hotkeys = new Input.Hotkeys(keys);
    hotkeys.apply();
    Harness.equal(keys.added.length, 0, "an absent list registers nothing");
};
