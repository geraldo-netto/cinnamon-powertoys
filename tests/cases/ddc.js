/*
 * External monitor brightness.
 *
 * ddcutil is not installed on the machine these were written on, and driving
 * a real monitor from a test would be rude anyway, so the command runner is
 * a parameter and every case supplies one. What is checked here is everything
 * except the wire: the output parsing against ddcutil's real formats, and
 * that nothing goes near a display until it is asked to.
 *
 * Naming a monitor reads pnp.ids, which is not on every machine, so the cases
 * that check a name run against the fixture instead of against this machine.
 */

const Harness = imports.harness;

const Ddc = Harness.requireXlet("./lib/ddc.js");
const Hardware = Harness.requireXlet("./lib/hardware.js");
const IO = Harness.requireXlet("./lib/io.js");

/* ddcutil --brief detect, with two monitors on one machine. */
const DETECT_TWO = [
    "Display 1",
    "   I2C bus:          /dev/i2c-4",
    "   DRM connector:    card1-DP-1",
    "   Monitor:          DEL:DELL U2415:7MT0184N0LTL",
    "",
    "Display 2",
    "   I2C bus:          /dev/i2c-5",
    "   DRM connector:    card1-HDMI-A-1",
    "   Monitor:          GSM:LG HDR 4K:0x01010101",
    "",
].join("\n");

/* Two of the same monitor, which report the same everything but the serial. */
const DETECT_TWINS = [
    "Display 1",
    "   I2C bus:          /dev/i2c-4",
    "   DRM connector:    card1-DP-1",
    "   Monitor:          DEL:DELL U2415:7MT0184N0LTL",
    "",
    "Display 2",
    "   I2C bus:          /dev/i2c-5",
    "   DRM connector:    card1-DP-2",
    "   Monitor:          DEL:DELL U2415:7MT0184N0AAA",
    "",
].join("\n");

/* What it says about a display it can see but cannot talk DDC to. */
const DETECT_NONE = [
    "Invalid display",
    "   I2C bus:          /dev/i2c-3",
    "   Monitor:          SAM:SyncMaster:HVCM200034",
    "   DDC communication failed",
    "",
].join("\n");

function detectMany(count) {
    let lines = [];
    for (let i = 1; i <= count; i++) {
        lines.push("Display " + i,
                   "   I2C bus:          /dev/i2c-" + i,
                   "   DRM connector:    card1-DP-" + i,
                   "   Monitor:          AOC:U27B3A" + i + ":SERIAL" + i,
                   "");
    }
    return lines.join("\n");
}

/* A recorder that answers whatever the case set up, in order. */
function runner(script) {
    let calls = [];
    let run = function (argv, onDone) {
        calls.push(argv.join(" "));
        let answer = script(argv);
        onDone(answer[0], answer[1]);
    };
    run.calls = calls;
    return run;
}

function detecting(output, status, brightness) {
    return runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [output, status];
        if (argv.indexOf("getvcp") >= 0)
            return [brightness === undefined ? "VCP 10 C 40 100\n" : brightness, 0];
        return ["", 0];
    });
}

/* Names come from pnp.ids, so the cases that check one need the fixture. */
function named(body) {
    Hardware.forget();
    IO.setRoot(Harness.fixture("machine"));
    try {
        return body();
    } finally {
        IO.setRoot("");
        Hardware.forget();
    }
}

function started(output, status, brightness) {
    let run = detecting(output, status, brightness);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    return { run: run, control: control };
}

var cases = {};

cases["what detect says about each display is picked out of it"] = function () {
    let displays = Ddc.parseDisplays(DETECT_TWO);
    Harness.equal(displays.length, 2, "two monitors");
    Harness.equal(displays[0].number, "1", "the number --display wants");
    Harness.equal(displays[0].bus, "/dev/i2c-4", "which bus it is on");
    Harness.equal(displays[0].connector, "card1-DP-1", "which socket it is in");
    Harness.equal(displays[0].manufacturer, "DEL", "the EDID maker code");
    Harness.equal(displays[0].model, "DELL U2415", "and the model");
    Harness.equal(displays[1].number, "2", "the second one");
};

cases["a display that cannot talk DDC is not one of ours"] = function () {
    Harness.deepEqual(Ddc.parseDisplays(DETECT_NONE), [],
                      "an Invalid display block is not a display");
    Harness.deepEqual(Ddc.parseDisplays(""), [], "nothing at all");
};

cases["a monitor is named after the monitor"] = function () {
    named(function () {
        let displays = Ddc.nameDisplays(Ddc.parseDisplays(DETECT_TWO));
        Harness.equal(displays[0].name, "Dell U2415", "make and model");
        Harness.equal(displays[1].name, "LG HDR 4K", "and the other one");
        Harness.equal(displays[0].name.indexOf("7MT0184N0LTL"), -1,
                      "the serial identifies the hardware and helps nobody read a menu");
    });
};

cases["two of the same monitor are told apart by where they are plugged in"] = function () {
    named(function () {
        let displays = Ddc.nameDisplays(Ddc.parseDisplays(DETECT_TWINS));
        Harness.equal(displays[0].name, "Dell U2415 (DP-1)", "the socket, not the serial");
        Harness.equal(displays[1].name, "Dell U2415 (DP-2)", "and the other socket");
    });
};

cases["brightness is a fraction of whatever the monitor's maximum is"] = function () {
    Harness.equal(Ddc.parseBrightness("VCP 10 C 40 100\n"), 40, "a maximum of 100");
    Harness.equal(Ddc.parseBrightness("VCP 10 C 32 64\n"), 50,
                  "a monitor whose scale is not percent");
    Harness.equal(Ddc.parseBrightness("VCP 10 C 0 100\n"), 0, "off");
    Harness.equal(Ddc.parseBrightness("VCP 12 C 40 100\n"), null, "a different feature");
    Harness.equal(Ddc.parseBrightness("VCP 10 ERR\n"), null, "an error");
    Harness.equal(Ddc.parseBrightness(""), null, "nothing");
    Harness.equal(Ddc.parseBrightness("VCP 10 C 40 0\n"), null, "a nonsense maximum");
};

cases["nothing is spawned until it is asked for"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    Harness.deepEqual(run.calls, [], "constructing it must not touch the I2C bus");
    Harness.equal(control.available, false, "and it claims nothing yet");
};

cases["a machine with monitors that answer ends up available"] = function () {
    let ready = 0;
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, () => ready++, run);
    control.start();
    Harness.equal(control.available, true, "available");
    Harness.equal(control.percentage, 40, "and knows where the brightness is");
    Harness.equal(control.monitors.length, 2, "one control per monitor");
    Harness.equal(control.monitors[0].available, true, "each of which answered");
    Harness.equal(ready, 1, "the caller was told, once");
};

cases["each monitor is asked for its own value"] = function () {
    let each = started(DETECT_TWO, 0);
    Harness.deepEqual(each.run.calls,
                      ["ddcutil --brief detect",
                       "ddcutil --brief --display 1 getvcp 10",
                       "ddcutil --brief --display 2 getvcp 10"],
                      "the detect, then one read per display");
};

cases["a machine without ddcutil ends up unavailable, quietly"] = function () {
    let ready = 0;
    let run = detecting("", -1);
    let control = new Ddc.DdcBacklight(null, () => ready++, run);
    control.start();
    Harness.equal(control.available, false, "nothing to control");
    Harness.equal(ready, 1, "the caller was still told");
    Harness.equal(run.calls.length, 1, "and it did not go on to ask for a value");
};

cases["a display that cannot talk DDC is not offered"] = function () {
    let each = started(DETECT_NONE, 0);
    Harness.equal(each.control.available, false, "detect saw it and could not reach it");
    Harness.equal(each.control.monitors.length, 0, "so there is no slider for it");
};

cases["a monitor that stops answering stops being available"] = function () {
    let each = started(DETECT_TWO, 0, "VCP 10 ERR\n");
    Harness.equal(each.control.monitors.length, 2, "both were detected");
    Harness.equal(each.control.monitors[0].available, false, "neither answered getvcp");
    Harness.equal(each.control.available, false, "so the group has nothing to offer");
};

cases["more monitors than there are sliders is said rather than hidden"] = function () {
    let each = started(detectMany(Ddc.MAX_DISPLAYS + 2), 0);
    Harness.equal(each.control.monitors.length, Ddc.MAX_DISPLAYS, "the cap holds");
    Harness.equal(each.control.hidden, 2, "and the two over it are counted");
};

cases["under the cap nothing is reported as hidden"] = function () {
    let each = started(detectMany(3), 0);
    Harness.equal(each.control.hidden, 0, "three of ten");
};

cases["starting twice probes once"] = function () {
    let each = started(DETECT_TWO, 0);
    let after = each.run.calls.length;
    each.control.start();
    Harness.equal(each.run.calls.length, after, "the second start did nothing");
};

cases["a monitor's slider moves that monitor and no other"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.monitors[1].setPercentage(70);
    Harness.deepEqual(each.run.calls, ["ddcutil --display 2 setvcp 10 70"],
                      "only the one that was dragged");
    Harness.equal(each.control.monitors[1].percentage, 70, "which follows the value");
    Harness.equal(each.control.monitors[0].percentage, 40, "and the other one does not");
};

cases["the panel wheel, which has no monitor in mind, moves all of them"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.setPercentage(70);
    Harness.deepEqual(each.run.calls,
                      ["ddcutil --display 1 setvcp 10 70",
                       "ddcutil --display 2 setvcp 10 70"], "both");
    Harness.equal(each.control.percentage, 70, "and the value it reports follows");
};

cases["a value outside the scale is brought back into it"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.setPercentage(140);
    each.control.setPercentage(-20);
    Harness.deepEqual(each.run.calls.filter(c => c.indexOf("--display 1") >= 0),
                      ["ddcutil --display 1 setvcp 10 100",
                       "ddcutil --display 1 setvcp 10 0"], "clamped both ways");
};

cases["a step moves by one notch from wherever it is"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.monitors[0].step(true);
    Harness.equal(each.run.calls[0], "ddcutil --display 1 setvcp 10 45", "up from 40");
    each.control.monitors[0].step(false);
    Harness.equal(each.run.calls[1], "ddcutil --display 1 setvcp 10 40", "and back down");
};

cases["a destroyed control stops claiming anything"] = function () {
    let each = started(DETECT_TWO, 0);
    Harness.equal(each.control.available, true, "before");
    each.control.destroy();
    Harness.equal(each.control.available, false, "after");
    each.run.calls.length = 0;
    each.control.setPercentage(10);
    Harness.deepEqual(each.run.calls, [], "and does not spawn anything else");
};

cases["a read is not started while a write is in flight"] = function () {
    let calls = [];
    let waiting = [];
    let run = function (argv, onDone) {
        calls.push(argv.join(" "));
        waiting.push(onDone);
    };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "A monitor" }, run);

    monitor.setPercentage(40, () => {});
    Harness.equal(calls.length, 1, "the write went out");

    let answered = false;
    monitor.refresh(() => { answered = true; });
    Harness.equal(calls.length, 1, "and no read went out behind it");
    Harness.equal(answered, true, "but the caller was still answered");

    waiting.shift()("", 0);
    monitor.refresh(() => {});
    Harness.equal(calls.length, 2, "once the write is done, a read goes out again");
    monitor.destroy();
};

cases["a refresh answers once, after every monitor has"] = function () {
    let waiting = [];
    let run = function (argv, onDone) { waiting.push(onDone); };
    let control = new Ddc.DdcBacklight(null, null, run);
    control.monitors = ["1", "2", "3"].map(
        number => new Ddc.DdcMonitor({ number: number, bus: "/dev/i2c-" + number }, run));

    let answers = 0;
    control.refresh(() => answers++);
    Harness.equal(answers, 0, "nothing has come back yet");
    while (waiting.length > 0)
        waiting.shift()("VCP 10 C 40 100\n", 0);
    Harness.equal(answers, 1, "answered exactly once, at the end");
    Harness.equal(control.available, true, "and the group took the answer");
};
