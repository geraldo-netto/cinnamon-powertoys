/*
 * What the panel says about a reading.
 *
 * The panel is the part of this applet that is always on screen, and until
 * these moved out of applet.js nothing could ask it anything. What is checked
 * here is the rules rather than the formatting - lib/format.js has its own
 * cases for that: when a profile is worth saying in words beside a gauge that
 * already says it, what a machine with nothing to report says, and whether
 * the tooltip names every consumption reading and device honestly.
 */

const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const PanelText = Harness.requireXlet("./lib/panel-text.js");

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;
const Level = UPowerGlib.DeviceLevel;

/* A reading, with only the parts the panel looks at. */
function reading(parts) {
    return Object.assign({
        upowerAvailable: true,
        devices: [],
        lines: [],
        primary: null,
        onBattery: false,
        cpu: { governor: null, averageFrequency: null, maxFrequency: null },
        selectedTemperature: null,
        powers: [],
        packageWatts: null,
        systemWatts: null,
        systemWattsSource: null,
        profile: { active: null, list: [] },
    }, parts || {});
}

function battery(parts) {
    return Object.assign({
        path: "/battery_BAT0", kind: Kind.BATTERY, state: State.DISCHARGING,
        vendor: "", model: "BAT0", powerSupply: true, percentage: 61,
        batteryLevel: Level.NONE,
        timeToEmpty: 7200, timeToFull: 0,
    }, parts || {});
}

function peripheral(parts) {
    return Object.assign({
        path: "/mouse", kind: Kind.MOUSE, state: State.UNKNOWN, vendor: "", model: "MX",
        powerSupply: false, percentage: 40, timeToEmpty: 0, timeToFull: 0,
        batteryLevel: Level.NONE,
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

cases["a coarse battery level is written everywhere"] = function () {
    let coarse = battery({ percentage: 0, batteryLevel: Level.LOW });
    let data = reading({ primary: coarse, devices: [coarse] });
    Harness.equal(PanelText.labelText(data, options(), "battery", null), "Low", "panel label");
    Harness.ok(PanelText.tooltipText(data, options()).indexOf("BAT0: Low") >= 0,
               "tooltip: " + PanelText.tooltipText(data, options()));

    let mouse = peripheral({ percentage: 0, batteryLevel: Level.CRITICAL });
    let accessories = PanelText.tooltipText(reading({ devices: [mouse] }), options());
    Harness.ok(accessories.indexOf("MX: Critical") >= 0, "peripheral: " + accessories);
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
                  "Power source: AC", "the manager says it is plugged in");
    Harness.equal(PanelText.tooltipText(reading({ onBattery: true }), options()),
                  "Power source: Battery", "and it can say battery without a display device");
    Harness.equal(PanelText.powerStatusLabel(reading({ onBattery: true })),
                  "On battery power", "the menu uses the same source");
};

cases["a machine with no battery says it is on the mains"] = function () {
    let plugged = PanelText.tooltipText(reading(), options());
    Harness.equal(plugged.split("\n")[0], "Power source: AC", "the charger is in");

    /* With no manager, there is no evidence for either source. */
    let noUPower = PanelText.tooltipText(reading({ upowerAvailable: false }), options());
    Harness.equal(noUPower.split("\n")[0], "Power status unavailable", "not guessed as AC");
    Harness.equal(PanelText.powerStatusLabel(reading({ upowerAvailable: false })),
                  "Power status unavailable", "the menu agrees");
};

cases["the tooltip opens with the battery and how long it has"] = function () {
    let data = reading({ primary: battery({ percentage: 61, timeToEmpty: 7200 }) });
    let lines = PanelText.tooltipText(data, options()).split("\n");
    Harness.equal(lines[0], "Power source: AC", "which supply the machine is using");
    Harness.equal(lines[1], "Battery: 61% · Discharging · 2h 00m remaining",
                  "what it is, how full, what it is doing, and how long that leaves");
};

cases["the tooltip carries what the panel deliberately does not"] = function () {
    /*
     * The temperature and the draw are kept off the panel because a number
     * moving in the corner of the eye cannot be ignored and is not worth
     * acting on. The tooltip is read by choosing to hover, so they are here.
     */
    let data = reading({
        cpu: { governor: "schedutil", averageFrequency: 2440, maxFrequency: 4800 },
        selectedTemperature: {
            id: "cpu:tctl", label: "AMD Ryzen 7 Tctl", celsius: 62.5,
        },
        systemWatts: 24.4,
        systemWattsSource: "package",
        packageWatts: 24.4,
        profile: { active: "performance", list: ["balanced", "performance"] },
    });
    Harness.deepEqual(PanelText.tooltipText(data, options()).split("\n"),
                      ["Power source: AC", "", "Consumption",
                       "  Processor package total: 24 W", "", "Performance",
                       "  Profile: Performance",
                       "  Governor: Scheduler guided",
                       "  Processor: 2.44 GHz · maximum 4.80 GHz",
                       "  AMD Ryzen 7 Tctl: 62.5 °C"],
                      "related facts grouped in the order they answer to each other");
};

cases["consumption names system processor and graphics readings separately"] = function () {
    let data = reading({
        primary: battery(),
        systemWatts: 17.2,
        systemWattsSource: "battery",
        packageWatts: 9.8,
        powers: [
            { id: "gpu-power", kind: "gpu", group: "gpu0", groupLabel: "Radeon RX 6600",
              label: "amdgpu power", shortLabel: "Power", watts: 34.2 },
            { id: "cpu-ppt", kind: "cpu", group: "cpu0", groupLabel: "AMD Ryzen 7",
              label: "k10temp PPT", shortLabel: "Power", watts: 10.1 },
        ],
    });
    let lines = PanelText.tooltipText(data, options()).split("\n");
    Harness.deepEqual(lines.slice(4, 8),
                      ["  Whole system (battery): 17 W",
                       "  Processor package total: 9.8 W",
                       "  Radeon RX 6600: 34 W",
                       "  AMD Ryzen 7: 10 W"],
                      "none is promoted to an unnamed whole-machine total");
};

cases["consumption identifies a DTPM platform total"] = function () {
    let data = reading({
        systemWatts: 72,
        systemWattsSource: "platform",
        powers: [{ id: "dtpm-root", platformTotal: true, watts: 72 }],
    });
    let lines = PanelText.tooltipText(data, options()).split("\n");
    Harness.equal(lines.indexOf("  Platform total (DTPM): 72 W") >= 0, true,
                  "a platform aggregate is not called processor-package power");
};

cases["the tooltip draws the profile that was asked for"] = function () {
    /* The same value the panel gauge and the filled segment use, so a change
     * that is still in flight reads the same wherever it is shown. */
    let data = reading({ profile: { active: "balanced", list: ["balanced", "performance"] } });
    let text = PanelText.tooltipText(data, options({ pendingProfile: "performance" }));
    Harness.ok(text.indexOf("Profile: Performance") >= 0, "what was clicked: " + text);
};

cases["the tooltip shows every device with the status it reports"] = function () {
    /*
     * A tooltip may be long when many devices are attached, but silently
     * replacing some of them with a count makes it incomplete. Their stable
     * UPower order is kept and every known state is said.
     */
    let data = reading({
        devices: [
            peripheral({ path: "/a", model: "Mouse", percentage: 80,
                         state: State.DISCHARGING, timeToEmpty: 3600 }),
            peripheral({ path: "/b", model: "Keyboard", percentage: 15,
                         state: State.CHARGING, timeToFull: 1800 }),
            peripheral({ path: "/c", model: "Headset", percentage: 45 }),
            peripheral({ path: "/d", model: "Pad one", percentage: 30 }),
            peripheral({ path: "/e", model: "Pad two", percentage: 55 }),
        ],
    });

    Harness.deepEqual(PanelText.tooltipText(data, options()).split("\n"),
                      ["Power source: AC", "", "Devices",
                       "  Mouse: 80% · Discharging · 1h 00m remaining",
                       "  Keyboard: 15% · Charging · 30m until full",
                       "  Headset: 45%", "  Pad one: 30%", "  Pad two: 55%"],
                      "all of them, with known states and times");
};

cases["a device with no charge is still named"] = function () {
    /* Some UPower devices report their presence and state but no charge. */
    let data = reading({
        devices: [peripheral({ percentage: null })],
    });
    Harness.equal(PanelText.tooltipText(data, options()),
                  "Power source: AC\n\nDevices\n  MX", "present, not silently dropped");
};

cases["chargers and batteries are devices too"] = function () {
    let primary = battery({ path: "/display" });
    let data = reading({
        primary: primary,
        lines: [{ path: "/line", kind: Kind.LINE_POWER, vendor: "Dell", model: "130W",
                  online: true }],
        devices: [battery({ path: "/bat0", model: "BAT0", state: State.CHARGING,
                            percentage: 70, timeToEmpty: 0, timeToFull: 1200 }),
                  peripheral({ model: "MX", percentage: 40 })],
    });
    let text = PanelText.tooltipText(data, options());
    Harness.ok(text.indexOf("Dell 130W: Connected") >= 0, "charger: " + text);
    Harness.ok(text.indexOf("BAT0: 70% · Charging · 20m until full") >= 0,
               "physical battery: " + text);
    Harness.ok(text.indexOf("MX: 40%") >= 0, "peripheral: " + text);
};

cases["a fallback primary is shown once in the complete device section"] = function () {
    let primary = battery({ path: "/bat0" });
    let text = PanelText.tooltipText(reading({ primary: primary, devices: [primary] }), options());
    Harness.equal(text.indexOf("Battery: 61%"), -1, "no duplicate primary summary: " + text);
    Harness.ok(text.indexOf("BAT0: 61%") >= 0, "complete device list: " + text);
};

cases["a composite primary remains separate from every physical device"] = function () {
    let primary = battery({ path: "/display" });
    let physical = battery({ path: "/bat0" });
    let text = PanelText.tooltipText(
        reading({ primary: primary, devices: [physical] }), options());
    Harness.ok(text.indexOf("Battery: 61%") >= 0, "composite summary: " + text);
    Harness.ok(text.indexOf("BAT0: 61%") >= 0, "physical device: " + text);
};
