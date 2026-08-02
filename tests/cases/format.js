/*
 * Icon naming.
 *
 * lib/format.js is otherwise pure formatting, which PT-27b will cover. What
 * is here is the part that has to answer differently depending on the machine
 * it is running on, and so is worth pinning down: which icon name a device
 * gets when the preferred set is not installed.
 */

const Harness = imports.harness;

const Format = Harness.requireXlet("./lib/format.js");
const UPowerGlib = imports.gi.UPowerGlib;

const Kind = UPowerGlib.DeviceKind;

/* Runs body with a stand-in icon theme that owns exactly `names`. */
function withTheme(names, body) {
    Format.setIconLookup(name => names.indexOf(name) >= 0);
    try {
        return body();
    } finally {
        Format.setIconLookup(null);
    }
}

var cases = {};

cases["the xapp icons are used where they are installed"] = function () {
    withTheme(["xsi-input-mouse", "xsi-battery-level-100"], function () {
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse", "mouse");
        Harness.equal(Format.batteryIconName(), "xsi-battery-level-100", "battery");
    });
};

cases["a desktop without them falls back to the freedesktop names"] = function () {
    withTheme([], function () {
        Harness.equal(Format.deviceIconName(Kind.MOUSE), "input-mouse", "mouse");
        Harness.equal(Format.deviceIconName(Kind.KEYBOARD), "input-keyboard", "keyboard");
        Harness.equal(Format.deviceIconName(Kind.UPS), "uninterruptible-power-supply", "ups");
        Harness.equal(Format.deviceIconName(Kind.GAMING_INPUT), "input-gaming", "controller");
        Harness.equal(Format.batteryIconName(), "battery-full", "battery");
    });
};

cases["every device icon has a fallback that is not an xapp name"] = function () {
    withTheme([], function () {
        for (let kind in Format.DEVICE_ICONS) {
            let fallback = Format.DEVICE_ICONS[kind][1];
            Harness.ok(fallback, "kind " + kind + " has no fallback");
            Harness.equal(fallback.indexOf("xsi-"), -1,
                          "kind " + kind + " falls back to another xapp name: " + fallback);
        }
        Harness.equal(Format.BATTERY_ICON[1].indexOf("xsi-"), -1, "the battery fallback");
    });
};

cases["with no icon theme to ask, the preferred name is used"] = function () {
    Format.setIconLookup(null);
    Harness.equal(Format.deviceIconName(Kind.MOUSE), "xsi-input-mouse",
                  "nothing to check against, so no reason to give up the better name");
};

cases["an unknown kind gets whatever the caller offered"] = function () {
    withTheme([], function () {
        Harness.equal(Format.deviceIconName(Kind.MODEM, null), null, "no default asked for");
        Harness.equal(Format.deviceIconName(Kind.MODEM, "battery-full"), "battery-full", "one was");
    });
};

cases["the theme is asked once per name, not once per row"] = function () {
    let asked = 0;
    Format.setIconLookup(function (name) {
        asked++;
        return false;
    });
    try {
        for (let i = 0; i < 10; i++)
            Format.deviceIconName(Kind.MOUSE);
        Harness.equal(asked, 1, "ten rows, one lookup");
    } finally {
        Format.setIconLookup(null);
    }
};
