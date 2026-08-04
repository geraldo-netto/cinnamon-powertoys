/*
 * What the panel says about a reading.
 *
 * The panel is the part of this applet that is always on screen, and until
 * these moved out of applet.js nothing could ask it anything. What is checked
 * here is the rules rather than the formatting - lib/format.js has its own
 * cases for that: when a profile is worth saying in words beside a gauge that
 * already says it, what a machine with nothing to report says, and how many
 * accessories fit in a tooltip before the rest are counted instead.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const PanelText = Harness.requireXlet("./lib/panel-text.js");

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;

/* A reading, with only the parts the panel looks at. */
function reading(parts) {
    return Object.assign({
        upowerAvailable: true,
        devices: [],
        primary: null,
        onBattery: false,
        lineOnline: false,
        cpu: { governor: null },
        cpuTemperature: null,
        systemWatts: null,
        systemWattsSource: null,
        profile: { active: null, list: [] },
    }, parts || {});
}

function battery(parts) {
    return Object.assign({
        path: "/battery_BAT0", kind: Kind.BATTERY, state: State.DISCHARGING,
        vendor: "", model: "BAT0", powerSupply: true, percentage: 61,
        timeToEmpty: 7200, timeToFull: 0,
    }, parts || {});
}

function peripheral(parts) {
    return Object.assign({
        path: "/mouse", kind: Kind.MOUSE, state: State.UNKNOWN, vendor: "", model: "MX",
        powerSupply: false, percentage: 40, timeToEmpty: 0, timeToFull: 0,
    }, parts || {});
}

function options(parts) {
    return Object.assign({
        showBattery: true, showPower: false, showProfile: false,
        iconSource: "auto", tempUnit: "celsius", pendingProfile: null,
    }, parts || {});
}

var cases = {};

/* ------------------------------------------------------------------ */
/* what may be in the panel text at all                                 */

cases["the list says which of the three the panel carries"] = function () {
    /* Three switches are eight arrangements and the ones anybody wants are
     * these three, which is why the list replaced them. */
    let all = { battery: true, power: true, profile: true };
    Harness.deepEqual(PanelText.panelParts("battery", all),
                      { battery: true, power: false, profile: false }, "the charge");
    Harness.deepEqual(PanelText.panelParts("battery-power", all),
                      { battery: true, power: true, profile: false }, "and the draw with it");
    Harness.deepEqual(PanelText.panelParts("none", all),
                      { battery: false, power: false, profile: false }, "or nothing at all");
};

cases["the switches are only read where the list defers to them"] = function () {
    let switches = { battery: false, power: true, profile: true };
    Harness.deepEqual(PanelText.panelParts("custom", switches), switches, "as they stand");
    Harness.deepEqual(PanelText.panelParts("battery", switches),
                      { battery: true, power: false, profile: false },
                      "and ignored otherwise");
};

cases["a setting that says nothing recognisable still draws something"] = function () {
    /*
     * A key that did not bind leaves its property undefined, and a schema that
     * has moved on can leave a value this applet has never heard of. Either
     * way the panel is on screen and has to say something; the default entry
     * is the charge.
     */
    let expected = { battery: true, power: false, profile: false };
    Harness.deepEqual(PanelText.panelParts(undefined, {}), expected, "nothing bound");
    Harness.deepEqual(PanelText.panelParts("something-else", {}), expected, "nothing known");
    Harness.deepEqual(PanelText.panelParts("custom", undefined),
                      { battery: false, power: false, profile: false },
                      "and switches that are not there are not on");
};

cases["an upgrade keeps the panel somebody already had"] = function () {
    /*
     * Read once per install, on the way past the three switches to the list
     * that replaced them - and never again, which is why it is worth being
     * able to ask it at all.
     */
    Harness.equal(PanelText.migratedPanelText({ battery: true, power: false, profile: false }),
                  "battery", "the default arrangement");
    Harness.equal(PanelText.migratedPanelText({ battery: true, power: true, profile: false }),
                  "battery-power", "the charge and the draw");
    Harness.equal(PanelText.migratedPanelText({ battery: false, power: false, profile: false }),
                  "none", "a panel that said nothing goes on saying nothing");
    Harness.equal(PanelText.migratedPanelText({ battery: false, power: false, profile: true }),
                  "custom", "and anything else keeps the switches doing what they did");
};

cases["what the switches meant is what the entry chosen for them means"] = function () {
    /*
     * The two halves against each other, over all eight arrangements: whatever
     * entry the migration picks has to draw the same panel the switches drew,
     * or an upgrade silently changes what somebody is looking at.
     */
    for (let battery of [false, true]) {
        for (let power of [false, true]) {
            for (let profile of [false, true]) {
                let switches = { battery: battery, power: power, profile: profile };
                let chosen = PanelText.migratedPanelText(switches);
                Harness.deepEqual(PanelText.panelParts(chosen, switches), switches,
                                  JSON.stringify(switches) + " became " + chosen);
            }
        }
    }
};

/* ------------------------------------------------------------------ */
/* which of the three things the icon is drawn from                     */

cases["the icon follows the battery, then the profile, then nothing"] = function () {
    /* "auto" is the default and is settled here rather than in the drawing,
     * because the label has to know what the icon decided: a profile already
     * drawn as a gauge does not need spelling out beside it. */
    Harness.equal(PanelText.iconSource(reading({ primary: battery() }), "auto", "balanced"),
                  "battery", "a laptop");
    Harness.equal(PanelText.iconSource(reading(), "auto", "balanced"),
                  "profile", "a desktop with a profile");
    Harness.equal(PanelText.iconSource(reading(), "auto", null),
                  "static", "and one with neither");
};

cases["an icon that was asked for by name is what is drawn"] = function () {
    let data = reading({ primary: battery() });
    Harness.equal(PanelText.iconSource(data, "profile", "balanced"), "profile", "as asked");
    Harness.equal(PanelText.iconSource(data, "static", "balanced"), "static", "and again");
    /* Nothing set at all reads as auto, which is what an unbound setting
     * leaves behind. */
    Harness.equal(PanelText.iconSource(data, undefined, null), "battery", "and nothing is auto");
};

/* ------------------------------------------------------------------ */
/* the text beside it                                                   */

cases["the panel says the charge and, where asked, the draw"] = function () {
    let data = reading({ primary: battery({ percentage: 61 }), systemWatts: 12.4,
                         systemWattsSource: "battery" });

    Harness.equal(PanelText.labelText(data, options(), "battery", null), "61%",
                  "the charge on its own");
    Harness.equal(PanelText.labelText(data, options({ showPower: true }), "battery", null),
                  "61% · 12 W", "and the draw beside it");
    Harness.equal(PanelText.labelText(data, options({ showBattery: false }), "battery", null),
                  "", "and nothing at all where nothing was asked for");
};

cases["a draw that is not the battery's says which it is"] = function () {
    /* A desktop that cannot read its RAPL counters would otherwise show the
     * graphics card's 54 W as though it were the machine. */
    let data = reading({ systemWatts: 54, systemWattsSource: "gpu" });
    Harness.equal(PanelText.labelText(data, options({ showPower: true }), "static", null),
                  "54 W (GPU)", "named");

    let onBattery = reading({ primary: battery(), systemWatts: 12.4,
                              systemWattsSource: "battery" });
    Harness.equal(PanelText.labelText(onBattery, options({ showBattery: false, showPower: true }),
                                      "battery", null),
                  "12 W", "and the whole machine needs no explaining");
};

cases["a battery with no percentage is not a percentage"] = function () {
    /* A device that reports a coarse level rather than a figure. The menu says
     * "Low"; the panel has no room to and says nothing. */
    let data = reading({ primary: battery({ percentage: null }) });
    Harness.equal(PanelText.labelText(data, options(), "battery", null), "", "nothing to print");
};

cases["a profile drawn as a gauge is not also spelled out"] = function () {
    /*
     * On a desktop the icon settles on the profile, and "Balanced" printed
     * beside the balanced gauge is one fact taking two pieces of the panel.
     */
    let data = reading({ profile: { active: "balanced",
                                    list: ["power-saver", "balanced", "performance"] } });
    Harness.equal(PanelText.labelText(data, options({ showProfile: true }), "profile", "balanced"),
                  "", "the gauge already said it");
    Harness.equal(PanelText.labelText(data, options({ showProfile: true }), "battery", "balanced"),
                  "Balanced", "and where it did not, the word stays");
};

cases["a profile whose gauge is shared is spelled out anyway"] = function () {
    /*
     * power-saver, low-power, quiet and cool all draw the leaf. Firmware that
     * offers two of them draws one gauge for both, and then the word is the
     * only thing telling them apart.
     */
    let shared = reading({ profile: { active: "quiet", list: ["quiet", "cool", "performance"] } });
    Harness.equal(PanelText.labelText(shared, options({ showProfile: true }), "profile", "quiet"),
                  "Quiet", "two profiles, one gauge");

    /* And a profile with no gauge of its own at all: the panel falls back to
     * the plain applet icon, so the word is all there is. */
    let unknown = reading({ profile: { active: "vendor-turbo", list: ["vendor-turbo"] } });
    Harness.equal(PanelText.labelText(unknown, options({ showProfile: true }),
                                      "profile", "vendor-turbo"),
                  "Vendor turbo", "nothing draws it, so it is written");
};

cases["a machine with no profile has no profile to say"] = function () {
    Harness.equal(PanelText.labelText(reading(), options({ showProfile: true }), "static", null),
                  "", "nothing to spell out");
};

/* ------------------------------------------------------------------ */
/* the tooltip                                                          */

cases["UPower establishes the source without a primary device"] = function () {
    Harness.equal(PanelText.tooltipText(reading({ onBattery: false }), options()),
                  "Running on AC power", "the manager says it is plugged in");
    Harness.equal(PanelText.tooltipText(reading({ onBattery: true }), options()),
                  "Running on battery power", "and it can say battery without a display device");
    Harness.equal(PanelText.powerStatusLabel(reading({ onBattery: true })),
                  "On battery power", "the menu uses the same source");
};

cases["a machine with no battery says it is on the mains"] = function () {
    let plugged = PanelText.tooltipText(reading({ lineOnline: true }), options());
    Harness.equal(plugged.split("\n")[0], "Running on AC power", "the charger is in");

    /* With no manager, there is no evidence for either source. */
    let noUPower = PanelText.tooltipText(reading({ upowerAvailable: false }), options());
    Harness.equal(noUPower.split("\n")[0], "Power status unavailable", "not guessed as AC");
    Harness.equal(PanelText.powerStatusLabel(reading({ upowerAvailable: false })),
                  "Power status unavailable", "the menu agrees");
};

cases["the tooltip opens with the battery and how long it has"] = function () {
    let data = reading({ primary: battery({ percentage: 61, timeToEmpty: 7200 }) });
    let lines = PanelText.tooltipText(data, options()).split("\n");
    Harness.equal(lines[0], "Battery 61% - Discharging", "what it is, how full, what it is doing");
    Harness.equal(lines[1], "2h 00m remaining", "and how long that leaves");
};

cases["the tooltip carries what the panel deliberately does not"] = function () {
    /*
     * The temperature and the draw are kept off the panel because a number
     * moving in the corner of the eye cannot be ignored and is not worth
     * acting on. The tooltip is read by choosing to hover, so they are here.
     */
    let data = reading({
        lineOnline: true,
        cpu: { governor: "schedutil" },
        cpuTemperature: 62.5,
        systemWatts: 24.4,
        systemWattsSource: "package",
        profile: { active: "performance", list: ["balanced", "performance"] },
    });
    Harness.deepEqual(PanelText.tooltipText(data, options()).split("\n"),
                      ["Running on AC power",
                       "Profile: Performance",
                       "Governor: Scheduler guided",
                       "Temperature: 62.5 °C",
                       "Power draw: 24 W (package)"],
                      "one line each, in the order they answer to each other");
};

cases["the tooltip draws the profile that was asked for"] = function () {
    /* The same value the panel gauge and the filled segment use, so a change
     * that is still in flight reads the same wherever it is shown. */
    let data = reading({ profile: { active: "balanced", list: ["balanced", "performance"] } });
    let text = PanelText.tooltipText(data, options({ pendingProfile: "performance" }));
    Harness.ok(text.indexOf("Profile: Performance") >= 0, "what was clicked: " + text);
};

cases["the emptiest three accessories fit, and the rest are counted"] = function () {
    /*
     * A desk with a mouse, a keyboard, a headset and two controllers made an
     * eleven line tooltip, which is not read at all. The ones worth knowing
     * about are the emptiest, so those are the ones that fit.
     */
    let data = reading({
        lineOnline: true,
        devices: [
            peripheral({ path: "/a", model: "Mouse", percentage: 80 }),
            peripheral({ path: "/b", model: "Keyboard", percentage: 15 }),
            peripheral({ path: "/c", model: "Headset", percentage: 45 }),
            peripheral({ path: "/d", model: "Pad one", percentage: 30 }),
            peripheral({ path: "/e", model: "Pad two", percentage: 55 }),
        ],
    });

    Harness.deepEqual(PanelText.tooltipText(data, options()).split("\n"),
                      ["Running on AC power", "",
                       "Keyboard: 15%", "Pad one: 30%", "Headset: 45%",
                       "and 2 more"],
                      "three by charge, then a count of what is left");
};

cases["an accessory with no charge is not a line"] = function () {
    /* Reported by BlueZ or UPower without a percentage at all, which is most
     * of what is connected to a machine. */
    let data = reading({
        lineOnline: true,
        devices: [peripheral({ percentage: null }), battery()],
    });
    Harness.equal(PanelText.tooltipText(data, options()), "Running on AC power",
                  "nothing to add");
};

cases["accessories are separated from the established power source"] = function () {
    /* The blank line separates them from the machine's own status. */
    let data = reading({ devices: [peripheral({ model: "MX", percentage: 40 })] });
    Harness.equal(PanelText.tooltipText(data, options()),
                  "Running on AC power\n\nMX: 40%", "separated from the established source");
};
