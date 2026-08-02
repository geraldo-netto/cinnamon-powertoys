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
    Harness.equal(control.monitors.length, 1, "one left");
    Harness.equal(control.monitors[0], second, "and it is the one that was there");
    Harness.equal(control.monitors[0].number, "1",
                  "ddcutil numbers by position, so the number it is asked for moved");
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

cases["a read in flight holds off a write, as a write already held off a read"] = function () {
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
