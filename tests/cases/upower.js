/*
 * What UPower's devices contribute to the sensor lists, and which of them are
 * listed at all.
 *
 * Everything else about lib/upower.js needs a system bus and is covered by
 * live.js, which skips itself where there is not one. These two parts do not:
 * each is a function of a device list. sensorReadings is the one path into the
 * menu's sensor list that does not come from lib/sensors.js - the menu
 * concatenates the two and groups the result without knowing which came from
 * where, so the two have to produce the same shape, which is exactly the sort
 * of agreement that rots silently. reportedDevices is what decides whether a
 * device gets a row.
 */

const Fuzz = imports.fuzz;
const Harness = imports.harness;
const UPowerGlib = imports.gi.UPowerGlib;

const Format = Harness.requireXlet("./lib/format.js");
const Log = Harness.requireXlet("./lib/log.js");
const Sensors = Harness.requireXlet("./lib/sensors.js");
const UPower = Harness.requireXlet("./lib/upower.js");

const Kind = UPowerGlib.DeviceKind;
const State = UPowerGlib.DeviceState;

/* A UPower device with everything the readings look at, plus overrides. */
function device(overrides) {
    return Object.assign({
        path: "/org/freedesktop/UPower/devices/battery_BAT0",
        kind: 2,
        state: 2,
        vendor: "Sony",
        model: "BAT0",
        powerSupply: true,
        present: true,
        percentage: 62,
        energyRate: 11.2,
        temperature: 31.5,
    }, overrides || {});
}

var cases = {};

cases["a battery reports a temperature and a draw"] = function () {
    let readings = UPower.sensorReadings([device()]);
    Harness.equal(readings.temperatures.length, 1, "one temperature");
    Harness.equal(readings.powers.length, 1, "one power meter");
    Harness.equal(readings.temperatures[0].celsius, 31.5, "the temperature it reported");
    Harness.equal(readings.powers[0].watts, 11.2, "and the rate");
};

cases["a battery's readings are grouped under the battery"] = function () {
    let readings = UPower.sensorReadings([device()]);
    let temperature = readings.temperatures[0];
    let power = readings.powers[0];

    Harness.equal(temperature.group, power.group,
                  "one group per device, so the two sit together under one heading");
    Harness.equal(temperature.groupLabel, "Sony BAT0", "headed by what the device is called");
    Harness.equal(temperature.shortLabel, "Temperature",
                  "and the row says only what it measures, since the heading has the rest");
    Harness.equal(power.shortLabel, "Power", "likewise");
};

cases["two batteries are two groups"] = function () {
    let readings = UPower.sensorReadings([
        device(),
        device({ path: "/org/freedesktop/UPower/devices/battery_BAT1", model: "BAT1" }),
    ]);
    Harness.equal(readings.temperatures.length, 2, "both reported one");
    Harness.ok(readings.temperatures[0].group !== readings.temperatures[1].group,
               "and they are not run together under one heading");
};

cases["a peripheral contributes its temperature but not a draw"] = function () {
    let readings = UPower.sensorReadings([
        device({ powerSupply: false, model: "BW01", vendor: "" }),
    ]);
    Harness.equal(readings.temperatures.length, 1, "a headset that reports a temperature");
    Harness.equal(readings.powers.length, 0,
                  "but only a system battery's rate is the machine's power draw");
};

cases["a device that reports neither contributes nothing"] = function () {
    let readings = UPower.sensorReadings([device({ temperature: null, energyRate: null })]);
    Harness.deepEqual(readings, { temperatures: [], powers: [] }, "nothing to say");
};

cases["nothing at zero is taken as a reading"] = function () {
    /*
     * UPower has no "is present" beside Temperature: a device with no
     * thermometer publishes 0.0, and so would a battery that really was at
     * freezing. Every bluetooth peripheral on a desk reads 0.0, so trusting it
     * put a sensor group under a headset's name with one row in it saying the
     * headset was at 0 °C. The rare true reading is the one that has to go.
     */
    let cold = UPower.sensorReadings([device({ temperature: 0 })]);
    Harness.equal(cold.temperatures.length, 0, "not a temperature UPower can vouch for");

    let idle = UPower.sensorReadings([device({ energyRate: 0 })]);
    Harness.equal(idle.powers.length, 0,
                  "a battery at rest reports 0 W, and a row saying so is worse than no row");
};

cases["these readings carry what the sensor list reads off them"] = function () {
    /* The fields lib/sensors.js produces and the menu consumes, named here so
     * that adding one to the sensors and not to these fails rather than
     * quietly showing an undefined heading. */
    const WANTED = ["id", "measure", "kind", "label", "group", "groupLabel", "shortLabel"];
    let readings = UPower.sensorReadings([device()]);
    for (let reading of readings.temperatures.concat(readings.powers)) {
        for (let field of WANTED)
            Harness.ok(reading[field] !== undefined && reading[field] !== null,
                       reading.measure + " carries no " + field);
    }
};

cases["and carry no field nothing reads"] = function () {
    /*
     * The mirror of the case above, and it has already been earned: `charging`
     * was set on every battery power reading and read by nothing, for as long
     * as these readings have existed. The list above says the shape is at
     * least what the menu needs; this one says it is no more than that, which
     * is the half that rots quietly.
     */
    const ALLOWED = {
        temperature: ["id", "measure", "chip", "rawLabel", "kind", "label", "group",
                      "groupLabel", "shortLabel", "critical", "celsius"],
        power: ["id", "measure", "kind", "label", "group", "groupLabel", "shortLabel", "watts"],
    };
    let extra = [];
    let readings = UPower.sensorReadings([device()]);
    for (let reading of readings.temperatures.concat(readings.powers)) {
        for (let field in reading) {
            if (ALLOWED[reading.measure].indexOf(field) < 0)
                extra.push(reading.measure + "." + field);
        }
    }
    Harness.deepEqual(extra, [], "set here and read nowhere");
};

cases["a battery that is not fitted is not a battery at 0%"] = function () {
    /*
     * The case the two guards this replaced were written for and could not
     * reach. UPower publishes Percentage as a plain double, so an empty bay
     * reads 0.0 and not nothing, and both guards asked whether it was nothing.
     * A laptop with its battery out got a row saying 0%, and with no display
     * device composed it became the machine's own battery in the panel.
     */
    let out = UPower.reportedDevices([device({ present: false, percentage: 0, state: State.UNKNOWN })]);
    Harness.deepEqual(out, [], "IsPresent is the field that says so");

    let fitted = UPower.reportedDevices([device({ percentage: 0, state: State.EMPTY })]);
    Harness.equal(fitted.length, 1,
                  "a battery that really is flat still has a row, which is the whole difference");
};

cases["a device that says nothing at all is dropped"] = function () {
    /* What the second guard was for: a proxy that carries no properties
     * answers false to IsPresent as well, so one test covers both. */
    Harness.deepEqual(UPower.reportedDevices([{ path: "/x", kind: Kind.MOUSE }]), [],
                      "nothing to say about it and no row for it");
};

cases["the charger is reported elsewhere, not here"] = function () {
    let out = UPower.reportedDevices([device({ path: "/ac", kind: Kind.LINE_POWER }), device()]);
    Harness.equal(out.length, 1, "whether the cable is in is a different question");
    Harness.equal(out[0].kind, 2, "and the battery is what is left");
};

cases["the machine's own batteries come before what is plugged into it"] = function () {
    let out = UPower.reportedDevices([
        device({ path: "/mouse", kind: Kind.MOUSE, powerSupply: false }),
        device({ path: "/headset", kind: Kind.HEADSET, powerSupply: false }),
        device({ path: "/bat" }),
    ]);
    Harness.deepEqual(out.map(entry => entry.path), ["/bat", "/mouse", "/headset"],
                      "the system battery, then peripherals by kind");
};

cases["their kind is one the menu knows and keeps"] = function () {
    let readings = UPower.sensorReadings([device()]);
    Harness.equal(readings.temperatures[0].kind, "battery", "battery");
    Harness.equal(Sensors.isPrimaryKind("battery"), true,
                  "which survives the menu's default filter, or a laptop would never see it");
    Harness.equal(Format.measureName("temperature"), readings.temperatures[0].shortLabel,
                  "and the word is the one lib/sensors.js uses for the same thing");
};

/* ---------------------------------------------------------------- */
/* the monitor, against a stubbed bus                                */

/*
 * The bus is a parameter now, so what follows runs on a machine with no
 * UPower and no system bus at all - which is what CI is. What ran before was
 * live.js, which skips itself where there is no daemon, so the enumerating,
 * the counting and every guard around them had never been exercised anywhere
 * that mattered.
 *
 * The two are not the same test and both are wanted: live.js says the
 * interface XML still matches a real UPower, and these say what this module
 * makes of what UPower says.
 */

const DISPLAY = "/org/freedesktop/UPower/devices/DisplayDevice";
const BAT0 = "/org/freedesktop/UPower/devices/battery_BAT0";
const MOUSE = "/org/freedesktop/UPower/devices/mouse_dev";

/* A device as a proxy hands it over: UPower's own property names, which are
 * not the ones the descriptions carry. */
function proxyFor(overrides) {
    let stub = Object.assign({
        Type: Kind.BATTERY,
        State: State.DISCHARGING,
        Vendor: "Sony",
        Model: "BAT0",
        PowerSupply: true,
        IsPresent: true,
        Percentage: 62,
        EnergyRate: 11.2,
        Temperature: 31.5,
    }, overrides || {});

    stub.handlers = [];
    stub.disconnected = [];
    stub.connect = function (name, handler) {
        stub.handlers.push(handler);
        return stub.handlers.length;
    };
    stub.disconnect = function (id) {
        stub.disconnected.push(id);
    };
    return stub;
}

/* The manager, with whatever EnumerateDevices is to answer. */
function managerFor(paths, options) {
    let settings = options || {};
    let stub = {
        signals: {},
        propertyHandlers: [],
        disconnected: [],
        OnBattery: settings.onBattery === true,
        connectSignal: function (name, handler) {
            stub.signals[name] = handler;
            return Object.keys(stub.signals).length;
        },
        disconnectSignal: function (id) {
            stub.disconnected.push(id);
        },
        connect: function (name, handler) {
            stub.propertyHandlers.push(handler);
            return 9;
        },
        disconnect: function (id) {
            stub.disconnected.push(id);
        },
        EnumerateDevicesRemote: function (onDone) {
            if (settings.enumerateError)
                onDone(null, new Error("EnumerateDevices timed out"));
            else
                onDone([paths || []], null);
        },
    };
    return stub;
}

/*
 * A system bus carrying that manager and those devices, keyed by path. A path
 * nobody answers for reports its failure to the callback, which is what a
 * proxy for a device that went away between the enumeration and the ask does.
 *
 * Answers are handed over straight away unless the case says to hold them,
 * which is what keeps these cases ordinary functions: asynchronous in shape,
 * immediate in fact.
 */
function busFor(manager, devices, options) {
    let settings = options || {};
    let waiting = [];
    let stub = {
        asked: [],
        waiting: waiting,
        manager: function (onDone) {
            if (settings.noBus)
                throw new Error("no system bus here");
            /* Neither a proxy nor a reason, which is what a wrapper that was
             * handed a name nobody owns can answer with. */
            if (settings.silentManager) {
                onDone(null, null);
                return;
            }
            let answer = () => onDone(settings.managerError ? null : manager,
                                      settings.managerError || null);
            if (settings.holdManager)
                waiting.push(answer);
            else
                answer();
        },
        device: function (path, onDone) {
            stub.asked.push(path);
            let proxy = (devices || {})[path];
            let answer = () => onDone(proxy || null,
                                      proxy || settings.silentDevices
                                          ? null : new Error("no device at " + path));
            if (settings.holdDevices)
                waiting.push(answer);
            else
                answer();
        },
    };
    stub.answer = function () {
        return waiting.shift()();
    };
    return stub;
}

/* A monitor, with what it was told counted. */
function monitorOn(bus) {
    let counts = { changed: 0, ready: 0 };
    let monitor = new UPower.UPowerMonitor(() => counts.changed++, () => counts.ready++, bus);
    monitor.counts = counts;
    return monitor;
}

function logging(body) {
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        body(lines);
    } finally {
        Log.setSink(null);
    }
}

cases["a manager that answers with an error is no UPower"] = function () {
    /*
     * UPower not installed, or not started. The applet still has a menu to
     * draw, so what it needs is to be told that the answer is in - and told
     * once, or the menu is built twice on a machine that has nothing to put
     * in it.
     */
    logging(function (lines) {
        let monitor = monitorOn(busFor(null, {}, { managerError: new Error("no such name") }));

        Harness.equal(monitor.available, false, "nothing to be available");
        Harness.equal(monitor.counts.ready, 1, "the caller is told the answer is in, once");
        Harness.equal(monitor.counts.changed, 0, "and there is nothing to say changed");
        Harness.equal(lines.length, 1, "one line said about it");
        Harness.ok(lines[0].indexOf("no such name") >= 0,
                   "carrying what the bus said: " + lines[0]);
        monitor.destroy();
    });
};

cases["a bus that cannot be reached at all is logged, not thrown"] = function () {
    /*
     * Gio.DBus.system is a getter that connects, and it throws where there is
     * nothing to connect to. This is the applet's constructor: a throw here is
     * an empty panel rather than a menu with no battery in it.
     */
    logging(function (lines) {
        let monitor = monitorOn(busFor(null, {}, { noBus: true }));

        Harness.equal(monitor.available, false, "no UPower here");
        Harness.equal(lines.length, 1, "and one line about why: " + lines.join(""));
        Harness.ok(lines[0].indexOf("cannot reach UPower") >= 0, "naming what was not reached");
        monitor.destroy();
    });
};

cases["a manager answering after the applet has gone is dropped"] = function () {
    /*
     * The bus answers in its own time, and the applet can be removed from the
     * panel in between. Everything after this point connects signals and
     * enumerates, which is a monitor built on top of an object nobody holds
     * any more.
     */
    let bus = busFor(managerFor([BAT0]), { [BAT0]: proxyFor() }, { holdManager: true });
    let monitor = monitorOn(bus);

    monitor.destroy();
    bus.answer();

    Harness.equal(monitor.available, false, "still nothing available");
    Harness.equal(monitor.counts.ready, 0, "and nobody was told anything");
    Harness.deepEqual(bus.asked, [], "no device was ever asked for");
};

cases["an enumeration that fails still says the answer is in"] = function () {
    /*
     * UPower answered, so there is a manager and the applet can ask it things
     * - but the device list never arrived, so there is nothing to draw. Not
     * saying so is a menu that waits for an enumeration that has already
     * failed.
     */
    logging(function (lines) {
        let monitor = monitorOn(busFor(managerFor([], { enumerateError: true }), {}));

        Harness.equal(monitor.available, true, "the manager is there");
        Harness.deepEqual(monitor.snapshot(), [], "with no devices under it");
        Harness.equal(monitor.counts.ready, 1, "and the caller is told, once");
        Harness.ok(lines.join("").indexOf("EnumerateDevices failed") >= 0,
                   "with a line about it: " + lines.join(""));
        monitor.destroy();
    });
};

cases["a machine with no devices at all is ready and empty"] = function () {
    /* A desktop: UPower is running and has nothing to report. Both callbacks
     * still fire, because "nothing" is an answer the menu has to draw. */
    let monitor = monitorOn(busFor(managerFor([]), {}));

    Harness.equal(monitor.available, true, "UPower is there");
    Harness.deepEqual(monitor.snapshot(), [], "with nothing on it");
    Harness.equal(monitor.counts.ready, 1, "ready, once");
    Harness.equal(monitor.counts.changed, 1, "and told to draw what there is");
    monitor.destroy();
};

cases["every device is proxied, and ready waits for the last of them"] = function () {
    /*
     * The count is the only thing that knows when the enumeration is over.
     * Saying ready on the first answer is a menu drawn from a device list that
     * is still filling in, which on a laptop with a mouse is a battery row
     * that appears a moment after the menu does.
     */
    let bus = busFor(managerFor([BAT0, MOUSE]), {
        [BAT0]: proxyFor(),
        [MOUSE]: proxyFor({ Type: Kind.MOUSE, PowerSupply: false, Model: "MX", Percentage: 40 }),
    }, { holdDevices: true });
    let monitor = monitorOn(bus);

    Harness.deepEqual(bus.asked, [DISPLAY, BAT0, MOUSE],
                      "the composite battery and both devices were asked for");
    Harness.equal(monitor.counts.ready, 0, "nothing has answered yet");

    bus.answer();
    bus.answer();
    Harness.equal(monitor.counts.ready, 0, "the first device is not the last one");

    bus.answer();
    Harness.equal(monitor.counts.ready, 1, "and now the answer is in");
    Harness.equal(monitor.counts.changed, 1, "with one redraw for the lot");
    Harness.deepEqual(monitor.snapshot().map(entry => entry.path), [BAT0, MOUSE],
                      "both of them, the system battery first");
    monitor.destroy();
};

cases["a device that cannot be proxied is passed over, not waited for"] = function () {
    /*
     * A device unplugged between the enumeration and the ask. Its answer is an
     * error, and the count has to come down for it anyway - a device that is
     * counted and never answers is an applet that never says it is ready.
     */
    let monitor = monitorOn(busFor(managerFor([BAT0, MOUSE]), { [BAT0]: proxyFor() }));

    Harness.deepEqual(monitor.snapshot().map(entry => entry.path), [BAT0],
                      "the one that answered");
    Harness.equal(monitor.counts.ready, 1, "and the answer is in, rather than still pending");
};

cases["a device arriving after the applet has gone is not adopted"] = function () {
    let bus = busFor(managerFor([BAT0]), { [BAT0]: proxyFor() }, { holdDevices: true });
    let monitor = monitorOn(bus);

    monitor.destroy();
    while (bus.waiting.length)
        bus.answer();

    Harness.deepEqual(monitor.snapshot(), [], "nothing was taken on");
    Harness.equal(monitor.counts.ready, 0, "and nobody was told");
};

cases["a device announced twice is proxied once"] = function () {
    /*
     * UPower emits DeviceAdded for a device it already told us about - a dock
     * reconnecting, or an enumeration racing a signal. A second proxy for the
     * same path is a second property handler, and every change after it is
     * two redraws.
     */
    let manager = managerFor([BAT0]);
    let bus = busFor(manager, { [BAT0]: proxyFor() });
    let monitor = monitorOn(bus);

    let asked = bus.asked.length;
    manager.signals["DeviceAdded"](manager, null, [BAT0]);

    Harness.equal(bus.asked.length, asked, "the bus was not asked a second time");
    Harness.equal(monitor.snapshot().length, 1, "and there is still one of it");
    monitor.destroy();
};

cases["a device coming or going is a change the menu hears about"] = function () {
    let manager = managerFor([BAT0]);
    let bus = busFor(manager, { [BAT0]: proxyFor(), [MOUSE]: proxyFor({ Type: Kind.MOUSE, Model: "MX" }) });
    let monitor = monitorOn(bus);
    let changes = monitor.counts.changed;

    manager.signals["DeviceAdded"](manager, null, [MOUSE]);
    Harness.equal(monitor.snapshot().length, 2, "the mouse is on the list");
    Harness.equal(monitor.counts.changed, changes + 1, "and the menu was told");

    manager.signals["DeviceRemoved"](manager, null, [MOUSE]);
    Harness.equal(monitor.snapshot().length, 1, "and off it again");
    Harness.equal(monitor.counts.changed, changes + 2, "and told again");

    /* A property moving on a device the applet holds is a change too, and it
     * is the one that happens every few seconds. */
    let proxy = bus.asked.indexOf(BAT0) >= 0 ? monitor._devices.get(BAT0) : null;
    proxy.handlers[0]();
    Harness.equal(monitor.counts.changed, changes + 3, "a percentage moving is a redraw");
    monitor.destroy();
};

cases["the composite battery is what the panel speaks for"] = function () {
    /*
     * UPower builds one battery out of however many are fitted, and that is
     * the one figure a panel can show. It is not on every machine and not
     * always there before the first poll, which is what the fallback is for.
     */
    let display = proxyFor({ Model: "DisplayDevice", Percentage: 55 });
    let monitor = monitorOn(busFor(managerFor([BAT0]), {
        [DISPLAY]: display,
        [BAT0]: proxyFor({ Percentage: 62 }),
    }));

    let reading = monitor.read();
    Harness.equal(reading.primary.path, DISPLAY, "the composite one, where there is one");
    Harness.equal(reading.primary.percentage, 55, "and its figure, not the first battery's");
    monitor.destroy();
};

cases["the composite battery moving is news, like every other proxy's"] = function () {
    /*
     * It was the one proxy in the file built without a property handler. A
     * proxy keeps its own cache in step with the bus, so the figure was never
     * stale - but nothing told the applet it had moved, and the panel is drawn
     * from what the applet was told. It waited for the poll, or for one of the
     * real batteries to change on its own account, which is most of the time
     * and is not the same thing.
     */
    let display = proxyFor({ Model: "DisplayDevice", Percentage: 55 });
    let monitor = monitorOn(busFor(managerFor([]), { [DISPLAY]: display }));
    let changes = monitor.counts.changed;

    Harness.equal(display.handlers.length, 1, "the composite battery is listened to");
    display.handlers[0]();
    Harness.equal(monitor.counts.changed, changes + 1, "and a charge moving is a redraw");

    monitor.destroy();
    Harness.equal(display.disconnected.length, 1, "and the handler goes with the applet");
};

cases["a composite battery that is not one is not used"] = function () {
    /*
     * UPower exports the DisplayDevice on every machine, and on a desktop it
     * is a device of kind UNKNOWN that is not present. Reading a percentage
     * off it would put a battery on a machine that has none.
     */
    let notABattery = monitorOn(busFor(managerFor([BAT0]), {
        [DISPLAY]: proxyFor({ Type: Kind.UNKNOWN }),
        [BAT0]: proxyFor({ Percentage: 62 }),
    }));
    Harness.equal(notABattery.displayDevice(), null, "not a battery, so not the one");
    Harness.equal(notABattery.read().primary.path, BAT0, "the first fitted battery instead");
    notABattery.destroy();

    let notFitted = monitorOn(busFor(managerFor([BAT0]), {
        [DISPLAY]: proxyFor({ IsPresent: false }),
        [BAT0]: proxyFor({ Percentage: 62 }),
    }));
    Harness.equal(notFitted.displayDevice(), null, "a battery, and not in the machine");
    Harness.equal(notFitted.read().primary.path, BAT0, "so the fitted one speaks");
    notFitted.destroy();
};

cases["a machine with nothing that carries a charge has nothing to speak for it"] = function () {
    /*
     * A desktop with a mouse. The mouse has a battery and a row of its own,
     * and it is not what the panel reports: the panel is about the machine.
     */
    let monitor = monitorOn(busFor(managerFor([MOUSE]), {
        [MOUSE]: proxyFor({ Type: Kind.MOUSE, PowerSupply: false, Model: "MX" }),
    }));

    let reading = monitor.read();
    Harness.equal(reading.primary, null, "nothing speaks for the machine");
    Harness.equal(reading.devices.length, 1, "though the mouse still gets its row");
    monitor.destroy();
};

cases["a UPS speaks for the machine where there is no battery"] = function () {
    /* A desktop on a UPS is a machine that can be running on stored power,
     * which is the question `primary` exists to answer. */
    let ups = "/org/freedesktop/UPower/devices/ups_x";
    let monitor = monitorOn(busFor(managerFor([ups]), {
        [ups]: proxyFor({ Type: Kind.UPS, Model: "Back-UPS", Percentage: 91 }),
    }));

    Harness.equal(monitor.read().primary.path, ups, "the UPS");
    monitor.destroy();
};

cases["whether the machine is on battery is the manager's own answer"] = function () {
    let running = monitorOn(busFor(managerFor([], { onBattery: true }), {}));
    Harness.equal(running.read().onBattery, true, "unplugged");
    running.destroy();

    let plugged = monitorOn(busFor(managerFor([]), {}));
    Harness.equal(plugged.read().onBattery, false, "and plugged in");
    plugged.destroy();

    /* A monitor with no manager at all answers the same way as one that is
     * plugged in, rather than throwing on the way to the panel. */
    Harness.equal(plugged.onBattery, false, "and a destroyed monitor says the same");
};

cases["a destroyed monitor lets go of every handler it connected"] = function () {
    /*
     * Two bus signals, one property handler on the manager and one on every
     * device. Left connected they fire into an object nobody holds, for as
     * long as the session lasts.
     */
    let manager = managerFor([BAT0]);
    let batteryProxy = proxyFor();
    let monitor = monitorOn(busFor(manager, { [BAT0]: batteryProxy }));

    monitor.destroy();

    Harness.equal(manager.disconnected.length, 3, "both signals and the property handler");
    Harness.equal(batteryProxy.disconnected.length, 1, "and the device's own");
    Harness.equal(monitor.available, false, "and it claims nothing afterwards");
    Harness.deepEqual(monitor.snapshot(), [], "with no devices left to describe");
};

cases["a proxy that is neither an answer nor a reason is no proxy"] = function () {
    /*
     * The guards read "an error or no proxy", and both halves are needed: a
     * wrapper answers with an error where the name is not owned, and with
     * nothing at all where it was handed nothing to build from. Taking the
     * second as a working proxy means connecting a signal to null - in the
     * applet's constructor for the manager, and in the middle of an
     * enumeration for a device.
     */
    logging(function () {
        let manager = monitorOn(busFor(null, {}, { silentManager: true }));
        Harness.equal(manager.available, false, "no manager, so no UPower");
        Harness.equal(manager.counts.ready, 1, "and the caller is told the answer is in");
        manager.destroy();

        let devices = monitorOn(busFor(managerFor([BAT0, MOUSE]), { [BAT0]: proxyFor() },
                                       { silentDevices: true }));
        Harness.deepEqual(devices.snapshot().map(entry => entry.path), [BAT0],
                          "the device that was really there");
        Harness.equal(devices.counts.ready, 1, "and the count came down for the one that was not");
        devices.destroy();
    });
};

cases["a composite battery arriving after the applet has gone is not kept"] = function () {
    /* The same guard as every other answer that can arrive late, on the one
     * proxy that is asked for outside the enumeration. */
    let bus = busFor(managerFor([]), { [DISPLAY]: proxyFor() }, { holdDevices: true });
    let monitor = monitorOn(bus);

    monitor.destroy();
    while (bus.waiting.length)
        bus.answer();

    Harness.equal(monitor.displayDevice(), null, "nothing was taken on");
};

cases["a device that says nothing about itself still describes"] = function () {
    /*
     * UPower answers with the properties it has, and a device that has just
     * appeared - or a proxy built against a daemon that restarted under it -
     * carries none of them. Every field the menu draws has to come out of that
     * as something a formatter can hold: a kind, a state, a name, and a set of
     * flags that are false rather than undefined.
     */
    let bare = "/org/freedesktop/UPower/devices/bare";
    let monitor = monitorOn(busFor(managerFor([bare]), { [bare]: { connect: () => 1, disconnect: () => {} } }));

    let described = monitor._describe(monitor._devices.get(bare), bare);
    Harness.equal(described.kind, Kind.UNKNOWN, "a kind the menu knows the name of");
    Harness.equal(described.state, State.UNKNOWN, "and a state");
    Harness.equal(described.batteryLevel, UPowerGlib.DeviceLevel.NONE, "and a level");
    Harness.equal(described.vendor, "", "no maker, said as nothing rather than as undefined");
    Harness.equal(described.model, "", "no model either");
    Harness.equal(described.icon, "", "and no icon name");
    Harness.equal(described.powerSupply, false, "it does not power the machine");
    Harness.equal(described.online, false, "nothing is plugged into it");
    Harness.equal(described.present, false, "and it is not fitted");
    Harness.equal(described.percentage, null, "with no charge to report");
    monitor.destroy();
};

cases["the charger is the one device kept on the other list"] = function () {
    /*
     * Whether the cable is in is a different question from what is carrying a
     * charge, so line power devices are reported through lineDevices() and
     * left out of the rows. Reading the two the same way round is a menu that
     * says a laptop has a battery called Mains.
     */
    let mains = "/org/freedesktop/UPower/devices/line_power_AC";
    let monitor = monitorOn(busFor(managerFor([mains, BAT0]), {
        [mains]: proxyFor({ Type: Kind.LINE_POWER, Model: "AC", Online: true, IsPresent: true }),
        [BAT0]: proxyFor(),
    }));

    let reading = monitor.read();
    Harness.deepEqual(reading.lines.map(entry => entry.path), [mains], "the charger, on its own list");
    Harness.deepEqual(reading.devices.map(entry => entry.path), [BAT0], "and not on the other one");
    Harness.equal(reading.lineOnline, true, "the cable is in");
    monitor.destroy();
};

cases["a battery that does not power the machine does not speak for it"] = function () {
    /*
     * A headset reports itself as a battery, and it is not what the panel is
     * about: powerSupply is what separates the machine's own cells from
     * whatever is paired with it. Without it a laptop on mains shows the
     * headset's charge as its own.
     */
    let headset = "/org/freedesktop/UPower/devices/headset_x";
    let monitor = monitorOn(busFor(managerFor([headset]), {
        [headset]: proxyFor({ Type: Kind.BATTERY, PowerSupply: false, Model: "BW01", Percentage: 30 }),
    }));

    Harness.equal(monitor.read().primary, null, "nothing of the machine's own");
    Harness.equal(monitor.read().devices.length, 1, "though it still has a row");
    monitor.destroy();
};

cases["two batteries of the same kind are ordered by path"] = function () {
    /*
     * A laptop with two cells reports them as two devices of one kind, and
     * the order they are drawn in is the only thing that keeps BAT0 above
     * BAT1 between one poll and the next. UPower enumerates in whatever order
     * it likes.
     */
    let second = "/org/freedesktop/UPower/devices/battery_BAT1";
    let monitor = monitorOn(busFor(managerFor([second, BAT0]), {
        [second]: proxyFor({ Model: "BAT1" }),
        [BAT0]: proxyFor(),
    }));

    Harness.deepEqual(monitor.snapshot().map(entry => entry.path), [BAT0, second],
                      "BAT0 first, whichever order they arrived in");
    monitor.destroy();
};

/* ---------------------------------------------------------------- */
/* properties nobody here wrote                                      */

/*
 * A UPower proxy carries whatever the daemon published, and the daemon
 * publishes what the kernel gave it: a battery reporting a capacity of 4000%
 * because its firmware counts in a different unit, a device whose Percentage
 * arrives before its Type does, a peripheral that answers every property with
 * nothing at all.
 *
 * Everything the menu draws comes through _describe, so what is held here is
 * the shape it produces: numbers that are numbers, names that are strings, and
 * a list whose order is an order.
 */
function fuzzProxy(random) {
    /*
     * The types are the ones the interface declares, so what is varied is what
     * a daemon can really vary: which properties have arrived at all - a proxy
     * built the moment a device appeared has almost none of them - and what
     * the numbers are, which come from firmware and are not bounded by
     * anything. A capacity of four thousand percent is a real battery.
     */
    let proxy = {};
    let maybe = function (name, value) {
        if (!random.chance(4))
            proxy[name] = value;
    };

    maybe("Type", random.chance(2) ? random.pick([Kind.BATTERY, Kind.UPS, Kind.MOUSE,
                                                  Kind.LINE_POWER, Kind.KEYBOARD])
                                   : random.between(-2, 20));
    maybe("State", random.between(-2, 9));
    maybe("BatteryLevel", random.between(-2, 9));
    maybe("Vendor", Fuzz.text(random, 3));
    maybe("Model", Fuzz.text(random, 3));
    maybe("IconName", Fuzz.text(random, 2));
    maybe("PowerSupply", random.chance(2));
    maybe("Online", random.chance(2));
    maybe("IsPresent", random.chance(2));
    for (let name of ["Percentage", "Energy", "EnergyFull", "EnergyRate", "Voltage",
                      "Temperature", "Capacity", "ChargeCycles", "TimeToEmpty", "TimeToFull"])
        maybe(name, Fuzz.number(random));

    proxy.connect = () => 1;
    proxy.disconnect = () => {};
    return proxy;
}

cases["whatever UPower publishes describes into something the menu can draw"] = function () {
    const NUMBERS = ["percentage", "energy", "energyFull", "energyRate", "voltage",
                     "temperature", "capacity", "cycles", "timeToEmpty", "timeToFull"];

    Fuzz.forAll({ what: "a whole reading", runs: 300 }, function (random) {
        let devices = {};
        let paths = [];
        let count = random.between(0, 3);
        for (let i = 0; i < count; i++) {
            let path = "/org/freedesktop/UPower/devices/fuzz_" + i;
            devices[path] = fuzzProxy(random);
            paths.push(path);
        }
        if (random.chance(3))
            devices[DISPLAY] = fuzzProxy(random);
        return { paths: paths, devices: devices };
    }, function (input) {
        let monitor = monitorOn(busFor(managerFor(input.paths), input.devices));
        let reading = Fuzz.answers(() => monitor.read());

        for (let device of reading.devices.concat(reading.lines)) {
            Fuzz.isString(device.vendor, "the maker");
            Fuzz.isString(device.model, "the model");
            Fuzz.isString(device.icon, "the icon name");
            Harness.equal(typeof device.kind, "number", "a kind: " + Fuzz.show(device.kind));
            Harness.equal(typeof device.state, "number", "a state: " + Fuzz.show(device.state));
            for (let field of NUMBERS) {
                Harness.ok(device[field] === null || Number.isFinite(device[field]),
                           field + " is a number or nothing: " + Fuzz.show(device[field]));
            }
        }

        /* Every temperature and every draw the sensor list is given has to be
         * a number, or a row in it says NaN °C. */
        for (let entry of reading.temperatures)
            Harness.ok(Number.isFinite(entry.celsius),
                       "a temperature that is a number: " + Fuzz.show(entry.celsius));
        for (let entry of reading.powers)
            Harness.ok(Number.isFinite(entry.watts),
                       "a draw that is a number: " + Fuzz.show(entry.watts));

        Harness.ok(reading.primary === null ||
                   reading.primary.path === DISPLAY ||
                   reading.devices.some(device => device.path === reading.primary.path),
                   "what the panel speaks for is on the list, or is the composite one");

        monitor.destroy();
    });
};

cases["the order the rows come out in is an order"] = function () {
    /*
     * The list is sorted on three keys - whether it powers the machine, its
     * kind, then its path - and a comparator that is not consistent is a menu
     * whose rows change places between polls for no reason anybody can see.
     */
    Fuzz.forAll({ what: "the ordering", runs: 300 }, function (random) {
        let devices = [];
        let count = random.between(0, 6);
        for (let i = 0; i < count; i++) {
            devices.push({
                path: "/dev/" + random.between(0, 4),
                kind: random.pick([Kind.BATTERY, Kind.UPS, Kind.MOUSE, Kind.KEYBOARD]),
                powerSupply: random.chance(2),
                present: true,
            });
        }
        return devices;
    }, function (devices) {
        let out = Fuzz.answers(() => UPower.reportedDevices(devices));

        for (let i = 1; i < out.length; i++) {
            let before = out[i - 1];
            let after = out[i];
            if (before.powerSupply !== after.powerSupply) {
                Harness.equal(before.powerSupply, true,
                              "what powers the machine comes first");
                continue;
            }
            if (before.kind !== after.kind) {
                Harness.ok(before.kind < after.kind, "then by kind: " + before.kind +
                                                     " before " + after.kind);
                continue;
            }
            Harness.ok(before.path <= after.path,
                       "then by path: " + before.path + " before " + after.path);
        }
    });
};
