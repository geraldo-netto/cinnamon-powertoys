/*
 * Taking one reading of the whole machine, and making it.
 *
 * The waiting used to be four booleans on the applet and a function that
 * re-read all four, so there was no way to ask what a fifth part would do, or
 * what happens when one part settles twice.
 */

const Harness = imports.harness;

const Collection = Harness.requireXlet("./lib/collection.js");

function sources(overrides) {
    let base = {
        readings: { temperatures: [], powers: [], fans: [], packageWatts: null },
        profile: { available: false },
        upower: {
            available: true, devices: [], lines: [], primary: null, onBattery: false,
        },
        bluetooth: { available: false, missingFrom: () => [] },
        cpu: { governor: "powersave" },
        charge: { available: false, limit: null, state: null },
        sensorHint: "",
    };
    for (let key in overrides || {})
        base[key] = overrides[key];
    return base;
}

var cases = {};

cases["nothing to wait for settles at once"] = function () {
    let settled = 0;
    Collection.gather([], () => { settled++; });
    Harness.equal(settled, 1, "an empty gathering is a finished one");
};

cases["the last part to answer is the one that settles it"] = function () {
    let done = {};
    let settled = 0;
    Collection.gather([
        finish => { done.a = finish; },
        finish => { done.b = finish; },
    ], () => { settled++; });
    Harness.equal(settled, 0, "nothing has answered yet");
    done.a();
    Harness.equal(settled, 0, "one of two is not all of them");
    done.b();
    Harness.equal(settled, 1, "and the second one settles it");
};

cases["a part that answers before it returns does not settle the rest"] = function () {
    let settled = 0;
    let late = null;
    Collection.gather([
        finish => finish(),
        finish => { late = finish; },
    ], () => { settled++; });
    Harness.equal(settled, 0, "the first answer is not the whole reading");
    late();
    Harness.equal(settled, 1, "the part that had to wait is waited for");
};

cases["every part answering immediately still settles once"] = function () {
    let settled = 0;
    Collection.gather([finish => finish(), finish => finish()], () => { settled++; });
    Harness.equal(settled, 1, "once, not twice and not never");
};

cases["a part that answers twice is one answer"] = function () {
    let settled = 0;
    let done = {};
    Collection.gather([
        finish => { done.a = finish; },
        finish => { done.b = finish; },
    ], () => { settled++; });
    done.a();
    done.a();
    Harness.equal(settled, 0, "the same part twice is not two parts");
    done.b();
    Harness.equal(settled, 1, "and the reading is published once");
};

cases["a gathering with nothing to call is not an error"] = function () {
    Collection.gather([finish => finish()]);
    Collection.gather();
};

cases["what UPower did not mention is added to the devices"] = function () {
    let mouse = { path: "/mouse", kind: 5, percentage: 40 };
    let data = Collection.assemble(sources({
        bluetooth: { available: true, missingFrom: () => [mouse] },
    }));
    Harness.equal(data.devices.length, 1, "the BlueZ device is in the reading");
    Harness.equal(data.bluezAvailable, true, "and BlueZ is reported as answering");
};

cases["batteries are sensors too"] = function () {
    let battery = {
        path: "/BAT0", kind: 2, percentage: 61, temperature: 31, energyRate: 8,
        state: 2, isPresent: true, powerSupply: true,
    };
    let data = Collection.assemble(sources({
        upower: {
            available: true, devices: [battery], lines: [], primary: battery,
            onBattery: true,
        },
    }));
    Harness.ok(data.temperatures.length > 0,
               "a battery that reports a temperature is a temperature reading");
    Harness.ok(data.powers.length > 0, "and its discharge is a power reading");
};

cases["the assembled reading carries what was read into it"] = function () {
    let data = Collection.assemble(sources({
        cpu: { governor: "performance" },
        charge: { available: true, limit: 80, state: "applied" },
        readings: {
            temperatures: [], powers: [], fans: [{ label: "cpu", rpm: 900 }],
            packageWatts: 12,
        },
    }));
    Harness.equal(data.cpu.governor, "performance", "the processor snapshot is passed through");
    Harness.equal(data.chargeLimit, 80, "so is the charge limit");
    Harness.equal(data.chargeLimitAvailable, true, "and whether there is one to write");
    Harness.equal(data.packageWatts, 12, "and the package total");
    Harness.equal(data.fans.length, 1, "and the fans, which nothing here touches");
};

cases["a hint nobody matched is said out loud"] = function () {
    let data = Collection.assemble(sources({
        readings: {
            temperatures: [{ label: "Package id 0", celsius: 45, key: "coretemp/0" }],
            powers: [], fans: [], packageWatts: null,
        },
        sensorHint: "nothing by this name",
    }));
    Harness.equal(data.hintMatched, false,
                  "they asked for a sensor and it was not found");
    Harness.ok(data.selectedTemperature, "something is still shown");
};
