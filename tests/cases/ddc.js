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

const GLib = imports.gi.GLib;

const Fuzz = imports.fuzz;
const Harness = imports.harness;

const Ddc = Harness.requireXlet("./lib/ddc.js");
const Hardware = Harness.requireXlet("./lib/hardware.js");
const IO = Harness.requireXlet("./lib/io.js");
const Log = Harness.requireXlet("./lib/log.js");

/* Collects what the module logged, and puts the sink back. */
function logging(body) {
    let lines = [];
    Log.setSink(line => lines.push(line));
    try {
        body(lines);
    } finally {
        Log.setSink(null);
    }
}

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

/* One monitor, and the same machine after the second one is unplugged: the
 * survivor is display 1 now, because ddcutil numbers by position. */
const DETECT_ONE = [
    "Display 1",
    "   I2C bus:          /dev/i2c-4",
    "   DRM connector:    card1-DP-1",
    "   Monitor:          DEL:DELL U2415:7MT0184N0LTL",
    "",
].join("\n");

const DETECT_SECOND_ONLY = [
    "Display 1",
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
    let control = new Ddc.DdcBacklight(null, run);
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
    Harness.deepEqual(Ddc.parseBrightnessReading("VCP 10 C 32 64\n"),
                      { percentage: 50, maximum: 64 },
                      "the raw range is retained for writes");
};

cases["nothing is spawned until it is asked for"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, run);
    Harness.deepEqual(run.calls, [], "constructing it must not touch the I2C bus");
    Harness.equal(control.available, false, "and it claims nothing yet");
};

cases["a machine with monitors that answer ends up available"] = function () {
    let ready = 0;
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(() => ready++, run);
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
    let control = new Ddc.DdcBacklight(() => ready++, run);
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

cases["a monitor plugged in later gets a slider of its own"] = function () {
    let output = DETECT_ONE;
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [output, 0];
        if (argv.indexOf("getvcp") >= 0)
            return ["VCP 10 C 40 100\n", 0];
        return ["", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    Harness.equal(control.monitors.length, 1, "one to begin with");

    output = DETECT_TWO;
    control.redetect();
    Harness.equal(control.monitors.length, 2, "and two once the second is plugged in");
    Harness.equal(control.monitors[1].number, "2", "the new one knows its display number");
};

cases["a monitor that survives a re-detection is the same control"] = function () {
    let each = started(DETECT_TWO, 0);
    let first = each.control.monitors[0];

    each.control.redetect();
    Harness.equal(each.control.monitors[0], first,
                  "recognised by its bus, so its slider and a drag on it survive");
    Harness.equal(each.control.monitors[0].percentage, 40, "and it was re-read, not guessed");
};

cases["unplugging one renumbers the other rather than renaming it"] = function () {
    let output = DETECT_TWO;
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [output, 0];
        if (argv.indexOf("getvcp") >= 0)
            return ["VCP 10 C 40 100\n", 0];
        return ["", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    let second = control.monitors[1];

    /* The LG is now display 1, because the Dell in front of it is gone. */
    output = DETECT_SECOND_ONLY;
    control.redetect();
    Harness.equal(control.monitors.length, 2, "one partial result is held for confirmation");
    control.redetect();
    Harness.equal(control.monitors.length, 1, "one left");
    Harness.equal(control.monitors[0], second, "and it is the one that was there");
    Harness.equal(control.monitors[0].number, "1",
                  "ddcutil numbers by position, so the number it is asked for moved");
};

cases["an empty topology needs confirmation"] = function () {
    let output = DETECT_ONE;
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [output, 0];
        return ["VCP 10 C 40 100\n", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    Harness.equal(control.monitors.length, 1, "a known monitor");

    output = "";
    control.redetect();
    Harness.equal(control.monitors.length, 1, "one empty success may be a sleeping display");
    control.redetect();
    Harness.equal(control.monitors.length, 0, "the repeated empty topology is accepted");
};

cases["repeated detect failures eventually clear stale monitors"] = function () {
    let status = 0;
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [status === 0 ? DETECT_ONE : "", status];
        return ["VCP 10 C 40 100\n", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    status = -1;

    control.redetect();
    control.redetect();
    Harness.equal(control.monitors.length, 1, "brief command failure keeps the last topology");
    control.redetect();
    Harness.equal(control.monitors.length, 0, "a permanent failure cannot leave stale sliders");
};

cases["a monitor that misses one read keeps its slider"] = function () {
    let brightness = "VCP 10 C 40 100\n";
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [DETECT_TWO, 0];
        if (argv.indexOf("getvcp") >= 0)
            return [brightness, 0];
        return ["", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    Harness.equal(control.monitors[0].available, true, "it answered once");

    brightness = "VCP 10 ERR\n";
    control.refresh();
    Harness.equal(control.monitors[0].available, true,
                  "a monitor asleep or busy is not a monitor that has gone");
    Harness.equal(control.monitors[0].percentage, 40, "and the last value stands");
};

cases["a monitor that has never answered is not offered"] = function () {
    let each = started(DETECT_TWO, 0, "VCP 10 ERR\n");
    Harness.equal(each.control.monitors[0].known, false, "nothing ever came back");
    Harness.equal(each.control.monitors[0].available, false, "so there is nothing to move");
};

cases["a probe, a re-detection and a stop all tell the caller"] = function () {
    /*
     * There were two callbacks here and this case asserted the difference: a
     * probe answered onReady, a re-detection said onChanged. Nothing ever made
     * that distinction - the applet passed one function as both, because
     * syncing the sliders is all it does either way - so what is left is one
     * signal, and what it has to say is that the monitors are not what they
     * were.
     */
    let changed = 0;
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(() => changed++, run);

    control.start();
    Harness.equal(changed, 1, "the probe answered and there are monitors now");

    control.redetect();
    Harness.equal(changed, 2, "a monitor arriving is news, and this is how the menu hears it");

    control.stop();
    Harness.equal(changed, 3, "and so is every one of them going away");
};

cases["a re-detection before the first one starts it instead"] = function () {
    let each = { run: detecting(DETECT_TWO, 0) };
    let control = new Ddc.DdcBacklight(null, each.run);
    control.redetect();
    Harness.equal(control.monitors.length, 2, "the probe ran");
    Harness.equal(each.run.calls[0], "ddcutil --brief detect", "as the first probe");
};

/* A runner that holds every call until the case lets it answer, so a probe can
 * be looked at half way through: the detect back, its reads still out. */
function held() {
    let waiting = [];
    let run = function (argv, onDone) {
        waiting.push({ argv: argv.join(" "), onDone: onDone });
    };
    run.waiting = waiting;
    run.answer = function (output, status) {
        let next = waiting.shift();
        next.onDone(output === undefined ? "" : output, status === undefined ? 0 : status);
        return next.argv;
    };
    return run;
}

cases["a re-detection asked for inside a probe is dropped, not queued"] = function () {
    /*
     * The reads a detect starts are part of the probe. Lowering the flag when
     * the detect answered left them out, so a caller asking every second sent
     * the next detect across every bus while the last probe was still reading
     * one of them - and two ddcutil talking to one monitor is how ddcutil
     * comes back with nothing.
     */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);

    control.start();
    run.answer(DETECT_TWO, 0);
    Harness.equal(run.waiting.length, 2, "the detect is back and its two reads are out");

    control.redetect();
    Harness.equal(run.waiting.length, 2, "so a re-detection now sends nothing");

    run.answer("VCP 10 C 40 100\n", 0);
    control.redetect();
    Harness.equal(run.waiting.length, 1, "and one read still out is still a probe in flight");

    run.answer("VCP 10 C 40 100\n", 0);
    Harness.equal(run.waiting.length, 0, "the probe is over");
    control.redetect();
    Harness.equal(run.waiting[0].argv, "ddcutil --brief detect", "and the next one goes out");
};

cases["a re-detection is dropped while a single monitor is being read"] = function () {
    /*
     * A detect walks every bus, so it collides with a conversation already on
     * one of them. The applet lines the two up as a matter of course: opening
     * the menu refreshes every backlight - a getvcp per monitor - and then
     * starts the watch, whose first probe goes out at once.
     */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    run.answer(DETECT_TWO, 0);
    run.answer("VCP 10 C 40 100\n", 0);
    run.answer("VCP 10 C 40 100\n", 0);
    Harness.equal(control.busy, false, "the probe is over and both monitors are idle");

    /* What opening the menu does before the watch starts. */
    control.refresh();
    Harness.equal(control.busy, true, "two reads are out");
    control.redetect();
    Harness.equal(run.waiting.length, 2, "so no detect goes out on top of them");

    run.answer("VCP 10 C 40 100\n", 0);
    control.redetect();
    Harness.equal(run.waiting.length, 1, "one monitor still reading is still busy");

    run.answer("VCP 10 C 40 100\n", 0);
    Harness.equal(control.busy, false, "the bus is free");
    control.redetect();
    Harness.equal(run.waiting[0].argv, "ddcutil --brief detect", "and now the probe goes out");
};

cases["a re-detection is dropped while a monitor is being written to"] = function () {
    /* The other half, which is a drag: a setvcp in flight, a tick, a detect. */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    run.answer(DETECT_TWO, 0);
    run.answer("VCP 10 C 40 100\n", 0);
    run.answer("VCP 10 C 40 100\n", 0);

    control.monitors[0].setPercentage(70);
    Harness.equal(control.busy, true, "the write is on the bus");
    control.redetect();
    Harness.equal(run.waiting.length, 1, "the detect is dropped rather than sent behind it");

    run.answer("", 0);
    control.redetect();
    Harness.equal(run.waiting[0].argv, "ddcutil --brief detect", "and goes out once it is done");
};

cases["a probe that finds nothing to read is over when the detect answers"] = function () {
    /* The two ways out that start no reads: a detect that failed, and a detect
     * that found no display worth a slider. Neither may leave the flag up, or
     * nothing looks again for the rest of the session. */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    run.answer("", -1);
    control.redetect();
    Harness.equal(run.waiting.length, 1, "a failed detect does not lock the next one out");

    run.answer(DETECT_NONE, 0);
    control.redetect();
    Harness.equal(run.waiting.length, 1, "nor does one that found nothing to talk to");
};

cases["a probe disowned by stop does not end the one started after it"] = function () {
    /*
     * stop() lets a probe in flight go rather than waiting for it, so the
     * setting switched off and straight back on has two probes out at once.
     * The old one answers into a control that has moved on: what it found is
     * a list from before the control was emptied, and it must neither be
     * adopted on top of the fresh probe nor say that probe has finished.
     */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);

    control.start();
    control.stop();
    control.start();
    Harness.equal(run.waiting.length, 2, "the disowned detect, and the new one");

    /* The first, answering after the setting said no and yes again. */
    run.answer(DETECT_TWO, 0);
    Harness.deepEqual(control.monitors, [], "what it found belongs to the control it left");
    Harness.equal(run.waiting.length, 1, "and it started no reads");

    control.redetect();
    Harness.equal(run.waiting.length, 1,
                  "the new probe is still out, so nothing else goes near the bus");

    run.answer(DETECT_ONE, 0);
    Harness.equal(run.waiting.length, 1, "the new probe reads the monitor it found");
    run.answer("VCP 10 C 40 100\n", 0);
    Harness.equal(control.monitors.length, 1, "and that is the list that stands");
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

cases["a percentage is written on the monitor's raw scale"] = function () {
    let each = started(DETECT_TWO, 0, "VCP 10 C 32 64\n");
    each.run.calls.length = 0;
    each.control.monitors[0].setPercentage(75);
    Harness.deepEqual(each.run.calls, ["ddcutil --display 1 setvcp 10 48"],
                      "75 percent of a 64-step monitor");
    Harness.equal(each.control.monitors[0].percentage, 75,
                  "the public value remains a percentage");
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

cases["the wheel passes over a monitor that has never answered"] = function () {
    /*
     * No answer means no percentage, and stepBy from no percentage starts at
     * 50 - a number from nowhere, written to hardware that has already
     * declined to talk. The menu has always drawn this line: a monitor that
     * has never answered gets no slider, and there is nothing to drag.
     */
    let answering = "1";
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [DETECT_TWO, 0];
        if (argv.indexOf("getvcp") >= 0)
            return argv[argv.indexOf("--display") + 1] === answering
                ? ["VCP 10 C 40 100\n", 0] : ["VCP 10 ERR\n", 0];
        return ["", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    Harness.equal(control.monitors[0].known, true, "one answered");
    Harness.equal(control.monitors[1].known, false, "and one never has");

    run.calls.length = 0;
    control.stepBy(2);
    Harness.deepEqual(run.calls, ["ddcutil --display 1 setvcp 10 50"],
                      "only the one that has something to step from");

    run.calls.length = 0;
    control.setPercentage(30);
    Harness.deepEqual(run.calls, ["ddcutil --display 1 setvcp 10 30"],
                      "and an absolute value is no different: it is still a write");
};

cases["a group of monitors that have all never answered still answers its caller"] = function () {
    /* The count is what tells the group it has finished, so a group with
     * nothing to write to has to say so rather than leave a caller waiting. */
    let answered = 0;
    let each = started(DETECT_TWO, 0, "VCP 10 ERR\n");
    each.run.calls.length = 0;
    each.control.setPercentage(70, () => answered++);
    Harness.deepEqual(each.run.calls, [], "nothing was sent");
    Harness.equal(answered, 1, "and the caller was told, once");
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

/*
 * The same machine, except that every setvcp is refused. Reading still works,
 * which is what a monitor that has gone to sleep or been switched to its other
 * input looks like: it answered when the applet started and will not take a
 * write now.
 */
function writesRefused(brightness) {
    return runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [DETECT_TWO, 0];
        if (argv.indexOf("getvcp") >= 0)
            return [brightness === undefined ? "VCP 10 C 40 100\n" : brightness, 0];
        return ["", 1];
    });
}

cases["a write the monitor refused is not taken as its value"] = function () {
    logging(function (lines) {
        let run = writesRefused();
        let control = new Ddc.DdcBacklight(null, run);
        control.start();
        Harness.equal(control.monitors[0].percentage, 40, "where the monitor said it was");

        control.monitors[0].setPercentage(70);
        Harness.equal(control.monitors[0].percentage, 40,
                      "ddcutil would not take it, so the screen is still at 40");
        Harness.equal(control.monitors[0].available, true,
                      "a refused write is not proof the monitor has gone");

        /* The only trace there is: ddcutil's own complaint goes to a stderr
         * this module silences, and the slider cannot say anything, because
         * from the outside a refusal looks exactly like nothing happening. */
        Harness.equal(lines.length, 1, "one line per refused write");
        Harness.ok(lines[0].indexOf("would not set the brightness") >= 0 &&
                   lines[0].indexOf("Dell U2415") >= 0,
                   "naming the monitor, since there may be several: " + lines[0]);
    });
};

cases["a refused write does not stick through a later failed read"] = function () {
    /*
     * The two together are what made this worth fixing. A monitor that has
     * answered once keeps its last value through a read that fails, on purpose
     * - it is asleep, not gone. With the refused write recorded, the value it
     * kept was one the monitor had never been at, and nothing later would
     * correct it.
     */
    let answering = true;
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [DETECT_TWO, 0];
        if (argv.indexOf("getvcp") >= 0)
            return answering ? ["VCP 10 C 40 100\n", 0] : ["", 1];
        return ["", 1];
    });
    logging(function () {
        let control = new Ddc.DdcBacklight(null, run);
        control.start();

        control.monitors[0].setPercentage(70);
        answering = false;
        control.refresh();
        Harness.equal(control.monitors[0].percentage, 40,
                      "still the last value the monitor itself gave");
    });
};

cases["a write that was taken is"] = function () {
    /* The other half, so the guard cannot be tightened into never believing
     * anything. */
    let each = started(DETECT_TWO, 0);
    each.control.monitors[0].setPercentage(70);
    Harness.equal(each.control.monitors[0].percentage, 70, "ddcutil said it took it");
};

cases["a step moves by one notch from wherever it is"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.monitors[0].step(true);
    Harness.equal(each.run.calls[0], "ddcutil --display 1 setvcp 10 45", "up from 40");
    each.control.monitors[0].step(false);
    Harness.equal(each.run.calls[1], "ddcutil --display 1 setvcp 10 40", "and back down");
};

cases["stopping lets the monitors go without spawning anything"] = function () {
    let each = started(DETECT_TWO, 0);
    Harness.equal(each.control.available, true, "two monitors before");

    each.run.calls.length = 0;
    each.control.stop();
    Harness.equal(each.control.available, false, "nothing to offer once it is off");
    Harness.deepEqual(each.control.monitors, [], "and no monitor left to offer it");
    Harness.equal(each.control.percentage, null, "nor a value to report for one");
    Harness.deepEqual(each.run.calls, [], "letting go costs no ddcutil");
};

cases["switching it back on looks again"] = function () {
    /* From scratch on purpose: monitors may well have been plugged or
     * unplugged while it was off, and nothing was watching. */
    let each = started(DETECT_TWO, 0);
    each.control.stop();

    each.run.calls.length = 0;
    each.control.start();
    Harness.equal(each.control.available, true, "back");
    Harness.equal(each.control.monitors.length, 2, "and it found them again");
    Harness.ok(each.run.calls.indexOf("ddcutil --brief detect") >= 0,
               "by probing, not by remembering: " + each.run.calls.join(", "));
};

cases["a probe still in flight when it is stopped does not bring them back"] = function () {
    let waiting = [];
    let run = function (argv, onDone) {
        waiting.push(() => onDone(DETECT_TWO, 0));
    };
    let control = new Ddc.DdcBacklight(null, run);

    control.start();
    control.stop();
    /* ddcutil answers now, after the setting said no. */
    waiting.forEach(answer => answer());

    Harness.equal(control.available, false, "still off");
    Harness.deepEqual(control.monitors, [],
                      "or the sliders reappear a second after they were switched off");
};

cases["stopping something that was never started does nothing"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, run);
    control.stop();
    Harness.deepEqual(run.calls, [], "nothing was spawned to be let go of");

    control.start();
    Harness.equal(control.available, true, "and it can still be started afterwards");
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
    let control = new Ddc.DdcBacklight(null, run);
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

cases["a monitor is asked one thing at a time, reads included"] = function () {
    /*
     * The write guard was there from the start; the read checked the same flag
     * and never set it, so it was the one call that could overlap itself.
     * Opening the menu twice inside a probe's round trip does it, and so does
     * a monitors-changed re-detection landing on a menu open - and what comes
     * back from two getvcp on one bus is nothing, which on a monitor that has
     * answered before is kept as the value it already had.
     */
    let waiting = [];
    let run = function (argv, onDone) {
        waiting.push({ argv: argv.join(" "), onDone: onDone });
    };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" }, run);

    monitor.refresh();
    Harness.equal(waiting.length, 1, "the first read went out");
    monitor.refresh();
    Harness.equal(waiting.length, 1, "and the second waits rather than joining it on the bus");

    waiting.shift().onDone("VCP 10 C 40 100\n", 0);
    Harness.equal(monitor.percentage, 40, "the first answered");

    monitor.refresh();
    Harness.equal(waiting.length, 1, "and now the bus is free again");
};

cases["a write asked for during a read waits for the bus rather than being lost"] = function () {
    let waiting = [];
    let run = function (argv, onDone) {
        waiting.push({ argv: argv.join(" "), onDone: onDone });
    };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" }, run);

    monitor.refresh();
    monitor.setPercentage(70);
    Harness.deepEqual(waiting.map(call => call.argv),
                      ["ddcutil --brief --display 1 getvcp 10"],
                      "the write did not go out on top of the read");

    waiting.shift().onDone("VCP 10 C 40 100\n", 0);
    Harness.deepEqual(waiting.map(call => call.argv),
                      ["ddcutil --display 1 setvcp 10 70"],
                      "and went out once the read was done with the bus");
};

cases["the value a drag ends on is written, not dropped"] = function () {
    /*
     * A drag emits a value per motion event against a monitor that answers in
     * tenths of a second, so the value it ends on is the one most likely to
     * land inside the previous write's round trip. It used to be refused and
     * forgotten: the screen stopped where the last taken write put it, the
     * number beside the handle agreed, and the next refresh pulled the handle
     * back. The wheel gathers a flick before it reaches here (PT-136); a drag
     * has no gather.
     */
    let waiting = [];
    let run = function (argv, onDone) {
        waiting.push({ argv: argv.join(" "), onDone: onDone });
    };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" }, run);

    monitor.setPercentage(30);
    Harness.equal(waiting.length, 1, "the first one went out");

    monitor.setPercentage(60);
    monitor.setPercentage(90);
    Harness.equal(waiting.length, 1, "and the rest of the drag did not go out on top of it");

    waiting.shift().onDone("", 0);
    Harness.deepEqual(waiting.map(call => call.argv),
                      ["ddcutil --display 1 setvcp 10 90"],
                      "one trailing write, for where the drag ended and nowhere it passed through");

    waiting.shift().onDone("", 0);
    Harness.equal(monitor.percentage, 90, "which is where the monitor is left");
    Harness.equal(waiting.length, 0, "and there is nothing else to send");
};

cases["every write asked for is answered exactly once"] = function () {
    /* The group's setPercentage and refresh count their monitors down to know
     * when they have finished, so a callback that never comes is a count that
     * never reaches zero, and one that comes twice syncs against a value that
     * is still moving. */
    let waiting = [];
    let run = function (argv, onDone) { waiting.push(onDone); };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" }, run);

    let answers = 0;
    monitor.setPercentage(30, () => answers++);
    monitor.setPercentage(60, () => answers++);
    monitor.setPercentage(90, () => answers++);
    Harness.equal(answers, 1, "the one a newer value replaced, which is not going out");

    waiting.shift()("", 0);
    Harness.equal(answers, 2, "the write that did go out");
    waiting.shift()("", 0);
    Harness.equal(answers, 3, "and the held one, once it had been out too");
};

cases["a monitor destroyed with a write held still answers for it"] = function () {
    let waiting = [];
    let run = function (argv, onDone) { waiting.push(onDone); };
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" }, run);

    let answered = 0;
    monitor.setPercentage(30, () => answered++);
    monitor.setPercentage(90, () => answered++);
    monitor.destroy();
    Harness.equal(answered, 1,
                  "the held one, which is certainly not going out now, or a group waiting " +
                  "on this monitor waits for ever");

    /* The other is on the bus already and answers through its own callback,
     * which runCommand's timeout guarantees will happen either way. */
    waiting.shift()("", 0);
    Harness.equal(answered, 2, "and it does");
    Harness.equal(waiting.length, 0, "with nothing new sent to a monitor that has gone");
};

cases["a read that never answers does not lock the monitor out"] = function () {
    /* runCommand has an eight second timeout behind it, and it answers with a
     * failure rather than not answering, which is what clears the flag. */
    let answer = null;
    let monitor = new Ddc.DdcMonitor({ number: "1", bus: "/dev/i2c-4", name: "Dell U2415" },
                                     (argv, onDone) => { answer = onDone; });
    monitor.refresh();
    answer("", -1);

    let calls = [];
    monitor._run = (argv, onDone) => calls.push(argv.join(" "));
    monitor.refresh();
    Harness.equal(calls.length, 1, "asking again is allowed once the last one gave up");
};

cases["a gathered flick is one write, not one per notch"] = function () {
    /*
     * A monitor answers in tenths of a second and refuses a second write while
     * the first is in flight, so a flick sent notch by notch arrived as one
     * notch and the rest went nowhere. The wheel gathers the count; this
     * applies the total.
     */
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;

    each.control.stepBy(4);
    Harness.deepEqual(each.run.calls,
                      ["ddcutil --display 1 setvcp 10 60",
                       "ddcutil --display 2 setvcp 10 60"],
                      "four notches up from 40, in one write per monitor");
};

cases["a flick moves each monitor from its own value, not to one value"] = function () {
    /*
     * The sliders exist so that a bright screen and a dim one can be left set
     * differently. The group's stepBy took its own percentage - the first
     * monitor that answered - added the notches and broadcast that one number
     * to both, so one flick of the wheel flattened them together.
     */
    let run = runner(function (argv) {
        if (argv.indexOf("detect") >= 0)
            return [DETECT_TWO, 0];
        if (argv.indexOf("getvcp") >= 0)
            return [argv[argv.indexOf("--display") + 1] === "1"
                ? "VCP 10 C 80 100\n" : "VCP 10 C 20 100\n", 0];
        return ["", 0];
    });
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    Harness.equal(control.monitors[0].percentage, 80, "one bright");
    Harness.equal(control.monitors[1].percentage, 20, "and one dim");

    run.calls.length = 0;
    control.stepBy(2);
    Harness.deepEqual(run.calls,
                      ["ddcutil --display 1 setvcp 10 90",
                       "ddcutil --display 2 setvcp 10 30"],
                      "each ten points up from where it was, and still sixty apart");
};

cases["a gathered flick down is the same the other way"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.stepBy(-3);
    Harness.equal(each.run.calls[0], "ddcutil --display 1 setvcp 10 25", "three notches down");
};

cases["one notch is still one notch"] = function () {
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;
    each.control.monitors[0].step(true);
    Harness.equal(each.run.calls[0], "ddcutil --display 1 setvcp 10 45",
                  "which is what the slider's own wheel sends");
};

cases["the group's own wheel moves every monitor, both ways"] = function () {
    /* The menu's single row for "all monitors" has a wheel on it too, and it
     * is a different function from the one a monitor's own row calls. */
    let each = started(DETECT_TWO, 0);
    each.run.calls.length = 0;

    each.control.step(true);
    Harness.deepEqual(each.run.calls,
                      ["ddcutil --display 1 setvcp 10 45",
                       "ddcutil --display 2 setvcp 10 45"],
                      "one notch up, on both");

    each.run.calls.length = 0;
    each.control.step(false);
    Harness.deepEqual(each.run.calls,
                      ["ddcutil --display 1 setvcp 10 40",
                       "ddcutil --display 2 setvcp 10 40"],
                      "and one notch back down");
};

cases["a group with nothing in it refreshes to unavailable"] = function () {
    /*
     * Nothing answered the detect, so there is no monitor to ask and no count
     * to wait for. The caller still gets its callback: a refresh that never
     * answers is a menu row that stays in flight for the rest of the session.
     */
    let each = started(DETECT_NONE, 0);
    Harness.equal(each.control.monitors.length, 0, "no monitors were adopted");

    let answered = 0;
    each.control.available = true;
    each.run.calls.length = 0;
    each.control.refresh(() => answered++);

    Harness.equal(answered, 1, "the caller is answered");
    Harness.equal(each.control.available, false, "and the group says so");
    Harness.deepEqual(each.run.calls, [], "without spawning anything");

    each.control.refresh();
    Harness.equal(answered, 1, "and a refresh nobody is waiting on is allowed too");
};

cases["a group destroyed while a write is out answers and touches nothing"] = function () {
    /*
     * The menu is closed, or the setting switched off, between a slider being
     * dragged and the monitor answering. The write still comes back and the
     * count still reaches nought, and syncing there would put a percentage
     * back on a control that has been taken down - and read monitors that
     * destroy() has already emptied out of the list.
     */
    let run = held();
    let control = new Ddc.DdcBacklight(null, run);
    control.start();
    run.answer(DETECT_ONE, 0);
    run.answer("VCP 10 C 40 100\n", 0);

    let answered = 0;
    control.setPercentage(70, () => answered++);
    Harness.equal(run.waiting.length, 1, "the write is out");

    control.destroy();
    run.answer("", 0);

    Harness.equal(answered, 1, "the caller is still answered");
    Harness.equal(control.available, false, "and the group is still down");
    Harness.equal(control.percentage, 40,
                  "with nothing read back off a list that destroy has emptied");
};

/* ---------------------------------------------------------------- */
/* naming, where there is nothing to name a display by               */

cases["a display that says nothing about itself is named by its number"] = function () {
    /*
     * ddcutil reports what it could read, and a monitor behind a KVM or a
     * cheap adapter can come back with a bus and nothing else. The menu still
     * needs a row title, and the number is what --display takes, so it is the
     * one name that is always both true and useful.
     */
    let anonymous = [
        "Display 1",
        "   I2C bus:          /dev/i2c-4",
        "",
        "Display 2",
        "   I2C bus:          /dev/i2c-5",
        "",
    ].join("\n");

    named(function () {
        let displays = Ddc.nameDisplays(Ddc.parseDisplays(anonymous));
        Harness.equal(displays[0].name, "Display 1", "no maker, no model, no socket");
        Harness.equal(displays[1].name, "Display 2", "and the other one is not the same row");
    });
};

cases["two of the same monitor with no socket to name are told apart by number"] = function () {
    /*
     * The DRM connector is what normally tells twins apart, and it is the one
     * field ddcutil cannot report where the driver does not expose it. Two
     * rows both called "Dell U2415" are two rows nobody can tell apart, and
     * dragging one of them is a guess.
     */
    let twins = [
        "Display 1",
        "   I2C bus:          /dev/i2c-4",
        "   Monitor:          DEL:DELL U2415:7MT0184N0LTL",
        "",
        "Display 2",
        "   I2C bus:          /dev/i2c-5",
        "   Monitor:          DEL:DELL U2415:7MT0184N0AAA",
        "",
    ].join("\n");

    named(function () {
        let displays = Ddc.nameDisplays(Ddc.parseDisplays(twins));
        Harness.equal(displays[0].name, "Dell U2415 (1)", "the number stands in for the socket");
        Harness.equal(displays[1].name, "Dell U2415 (2)", "and the second is the second");
    });

    Harness.equal(Ddc._connectorName(null), null, "no socket is no name for one");
    Harness.equal(Ddc._connectorName("card2-HDMI-A-2"), "HDMI-A-2", "and a socket is the socket");
};

/* ---------------------------------------------------------------- */
/* the command runner itself                                        */

/*
 * The runner's own timer is eight seconds, which is right for a monitor and
 * far too long to wait for in a test. Only that one is shortened - the
 * harness's own guard timer is armed through the same function, and hurrying
 * that would make every settle here give up instantly.
 */
function hurried(ms, body) {
    let real = GLib.timeout_add;
    GLib.timeout_add = function (priority, delay, callback) {
        return real(priority, delay === Ddc.CALL_TIMEOUT_MS ? ms : delay, callback);
    };
    try {
        return body();
    } finally {
        GLib.timeout_add = real;
    }
}

cases["the module's own runner runs a command and reports what it said"] = function () {
    /*
     * Every case above hands in a runner of its own, so the one a running
     * applet uses - the only one there is in production - was exercised by
     * none of them. What it decides is what every ddcutil call comes back as:
     * the output the parsers read, and the status that says whether talking to
     * the monitor worked at all.
     */
    let said = Harness.settle(done => Ddc.runCommand(["echo", "VCP 10 C 40 100"],
        (output, status) => done({ output: output, status: status })),
        "a command that says something");
    Harness.equal(said.output, "VCP 10 C 40 100\n", "its output, as the parsers get it");
    Harness.equal(said.status, 0, "and the status that says it worked");

    let failed = Harness.settle(done => Ddc.runCommand(["sh", "-c", "exit 3"],
        (output, status) => done({ output: output, status: status })),
        "a command that fails");
    Harness.equal(failed.output, "", "nothing to read");
    Harness.ok(failed.status !== 0, "and a status that is not success: " + failed.status);

    /* ddcutil is chatty on stderr about buses it could not open, and none of
     * it is anything a parser here should ever see. */
    let noisy = Harness.settle(done => Ddc.runCommand(
        ["sh", "-c", "echo talking to the wrong bus >&2; echo VCP 10 C 40 100"],
        (output, status) => done({ output: output, status: status })),
        "a command that complains as it works");
    Harness.equal(noisy.output, "VCP 10 C 40 100\n", "only what it printed to stdout");
    Harness.equal(noisy.status, 0, "and it still worked");
};

cases["a command that cannot be run at all is an answer, not a crash"] = function () {
    /*
     * ddcutil not installed, which is the ordinary case on most machines. Gio
     * throws where the process cannot be started, and a throw here would come
     * up through a probe the user never asked for.
     */
    let outcome = Harness.settle(done => Ddc.runCommand(["/definitely/not/ddcutil"],
        (output, status) => done({ output: output, status: status })),
        "a program that is not there");
    Harness.equal(outcome.output, "", "nothing to parse");
    Harness.equal(outcome.status, -1, "and a failure of its own");
};

cases["output that no text can hold is an answer too"] = function () {
    /*
     * communicate_utf8_finish throws where the output is not valid UTF-8, and
     * ddcutil prints back what a monitor's EDID contains - which on a bad
     * cable is whatever arrived. A throw there is a call that never answers,
     * so the probe's count never reaches nought and every slider stays in
     * flight for the rest of the session.
     */
    let outcome = Harness.settle(done => Ddc.runCommand(
        ["sh", "-c", "printf 'Monitor: \\377\\376'"],
        (output, status) => done({ output: output, status: status })),
        "a command printing bytes that are not text");
    Harness.equal(outcome.output, "", "nothing to parse");
    Harness.equal(outcome.status, -1, "and a failure of its own");
};

cases["a monitor that never answers is given up on, once"] = function () {
    /*
     * ddcutil hangs where a monitor accepts the connection and then says
     * nothing, which is what a display asleep on a KVM does. Without the timer
     * that is a process left behind for the session and a probe that never
     * finishes.
     *
     * The process is killed and the caller answered, and then the killed
     * process's own callback arrives - so the guard that stops a caller being
     * answered twice is the other half of this.
     */
    logging(function (lines) {
        let answers = [];
        let outcome = hurried(10, () => Harness.settle(done => Ddc.runCommand(
            ["sleep", "30"], function (output, status) {
                answers.push(status);
                done({ output: output, status: status });
            }), "a command that never answers"));

        Harness.equal(outcome.status, -1, "given up on");
        Harness.equal(outcome.output, "", "with nothing to parse");
        Harness.equal(answers.length, 1, "and answered exactly once");
        Harness.ok(lines.join("\n").indexOf("did not answer in time") >= 0,
                   "and said so: " + lines.join("\n"));
    });
};

cases["a timer that is not needed is not left armed"] = function () {
    /*
     * Eight seconds of timer per call, against ten monitors probed every
     * refresh, is a source left on the main loop for every ddcutil the applet
     * has ever run. The command answered; the timer has nothing left to do.
     */
    let armed = [];
    let removed = [];
    let realAdd = GLib.timeout_add;
    let realRemove = GLib.source_remove;

    GLib.timeout_add = function (priority, delay, callback) {
        let id = realAdd(priority, delay, callback);
        if (delay === Ddc.CALL_TIMEOUT_MS)
            armed.push(id);
        return id;
    };
    GLib.source_remove = function (id) {
        if (armed.indexOf(id) >= 0)
            removed.push(id);
        return realRemove(id);
    };

    try {
        Harness.settle(done => Ddc.runCommand(["echo", "done"],
            (output, status) => done(status)), "a command that answers");
    } finally {
        GLib.timeout_add = realAdd;
        GLib.source_remove = realRemove;
    }

    Harness.equal(armed.length, 1, "one timer was armed for the call");
    Harness.deepEqual(removed, armed, "and it was taken back off when the answer came");
};

/* ---------------------------------------------------------------- */
/* what a monitor answers with, when it is not what it should be     */

/*
 * ddcutil's output is a machine's answer, and a monitor that half answers
 * gets it truncated, doubled or interleaved with whatever the tool wrote to
 * stdout about the bus it could not open. The cases above pick the shapes
 * somebody thought of; these throw shapes at it by the hundred and hold the
 * parsing to a property rather than to an answer.
 */
function detectText(random) {
    let lines = [];
    let blocks = random.below(4);
    for (let i = 0; i < blocks; i++) {
        lines.push(random.chance(4) ? Fuzz.text(random, 3)
                                    : "Display " + random.between(0, 12));
        let fields = random.below(5);
        for (let j = 0; j < fields; j++) {
            let name = random.pick(["I2C bus", "DRM connector", "Monitor", "VCP version",
                                    Fuzz.text(random, 2)]);
            lines.push("   " + name + ":    " + Fuzz.text(random, 4));
        }
        if (random.chance(3))
            lines.push(Fuzz.text(random, 3));
        lines.push("");
    }
    return lines.join(random.chance(6) ? "\r\n" : "\n");
}

cases["whatever ddcutil says about the displays is parsed or refused"] = function () {
    Fuzz.forAll({ what: "the detect parsing", runs: 400 }, detectText, function (input) {
        let displays = Fuzz.answers(() => Ddc.parseDisplays(input));

        for (let display of displays) {
            Fuzz.isString(display.number, "the display number");
            Harness.ok(/^\d+$/.test(display.number),
                       "the number is what --display takes: " + display.number);
            Fuzz.isString(display.manufacturer, "the maker code");
            Fuzz.isString(display.model, "the model");
            Fuzz.isString(display.serial, "the serial");
            Harness.ok(display.bus === null || typeof display.bus === "string", "the bus");
            Harness.ok(display.connector === null || typeof display.connector === "string",
                       "the connector");
        }
    });
};

cases["every display that is parsed can be given a row title"] = function () {
    /*
     * The names are what the menu draws, and a display carrying none of the
     * fields a name is built from still has to end up with one - a row with an
     * empty title is a slider nobody can say which screen belongs to.
     */
    named(function () {
        Fuzz.forAll({ what: "the naming", runs: 150 }, detectText, function (input) {
            let displays = Ddc.parseDisplays(input);
            let names = Fuzz.answers(() => Ddc.nameDisplays(displays));

            Harness.equal(names.length, displays.length, "one name per display");
            for (let display of names) {
                Fuzz.isString(display.name, "the row title");
                Harness.ok(display.name.trim().length > 0,
                           "a title with something in it: " + JSON.stringify(display.name));
            }
        });
    });
};

cases["a brightness reply is a percentage or nothing"] = function () {
    /*
     * The value behind every slider. It is worked out from two numbers the
     * monitor reports, because the maximum is not always 100 - and a monitor
     * that reports a current above its own maximum, or a maximum of nought,
     * is a monitor that would otherwise put a figure on screen that is not a
     * percentage of anything.
     */
    Fuzz.forAll({ what: "the brightness parsing", runs: 500 }, function (random) {
        if (random.chance(3))
            return "VCP 10 " + random.pick(["C", "SNC", "T", Fuzz.text(random, 1)]) + " " +
                   random.between(0, 300) + " " + random.between(0, 300);
        return Fuzz.text(random, 8);
    }, function (input) {
        let value = Fuzz.answers(() => Ddc.parseBrightness(input));
        Fuzz.inRange(value, 0, 100, "the brightness");
    });
};
