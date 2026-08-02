/*
 * External monitor brightness.
 *
 * ddcutil is not installed on the machine these were written on, and driving
 * a real monitor from a test would be rude anyway, so the command runner is
 * a parameter and every case supplies one. What is checked here is everything
 * except the wire: the output parsing against ddcutil's real formats, and
 * that nothing goes near a display until it is asked to.
 */

const Harness = imports.harness;

const Ddc = Harness.requireXlet("./lib/ddc.js");

/* ddcutil --brief detect, with two monitors on one machine. */
const DETECT_TWO = [
    "Display 1",
    "   I2C bus:  /dev/i2c-4",
    "   Monitor:  DEL:DELL U2415:7MT0184N0LTL",
    "",
    "Display 2",
    "   I2C bus:  /dev/i2c-5",
    "   Monitor:  GSM:LG HDR 4K:0x01010101",
    "",
].join("\n");

/* What it says about a display it can see but cannot talk DDC to. */
const DETECT_NONE = [
    "Invalid display",
    "   I2C bus:  /dev/i2c-3",
    "   Monitor:  SAM:SyncMaster:HVCM200034",
    "   DDC communication failed",
    "",
].join("\n");

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

var cases = {};

cases["ddcutil's display numbers are picked out of detect"] = function () {
    Harness.deepEqual(Ddc.parseDisplays(DETECT_TWO), ["1", "2"], "two monitors");
    Harness.deepEqual(Ddc.parseDisplays(DETECT_NONE), [],
                      "a display that cannot be talked to is not one of ours");
    Harness.deepEqual(Ddc.parseDisplays(""), [], "nothing at all");
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
    let run = detecting(DETECT_TWO, 0);
    let ready = 0;
    let control = new Ddc.DdcBacklight(null, () => ready++, run);
    control.start();
    Harness.equal(control.available, true, "available");
    Harness.equal(control.percentage, 40, "and knows where the brightness is");
    Harness.deepEqual(control.displays, ["1", "2"], "both displays");
    Harness.equal(ready, 1, "the caller was told, once");
};

cases["a machine without ddcutil ends up unavailable, quietly"] = function () {
    let run = detecting("", -1);
    let ready = 0;
    let control = new Ddc.DdcBacklight(null, () => ready++, run);
    control.start();
    Harness.equal(control.available, false, "nothing to control");
    Harness.equal(ready, 1, "the caller was still told");
    Harness.equal(run.calls.length, 1, "and it did not go on to ask for a value");
};

cases["a display that cannot talk DDC is not offered"] = function () {
    let run = detecting(DETECT_NONE, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    Harness.equal(control.available, false, "detect saw it and could not reach it");
};

cases["starting twice probes once"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    let after = run.calls.length;
    control.start();
    Harness.equal(run.calls.length, after, "the second start did nothing");
};

cases["one slider moves every monitor"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    run.calls.length = 0;
    control.setPercentage(70);
    Harness.deepEqual(run.calls,
                      ["ddcutil --display 1 setvcp 10 70",
                       "ddcutil --display 2 setvcp 10 70"], "both");
    Harness.equal(control.percentage, 70, "and the value it reports follows");
};

cases["a value outside the scale is brought back into it"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    run.calls.length = 0;
    control.setPercentage(140);
    control.setPercentage(-20);
    Harness.deepEqual(run.calls.filter(c => c.indexOf("--display 1") >= 0),
                      ["ddcutil --display 1 setvcp 10 100",
                       "ddcutil --display 1 setvcp 10 0"], "clamped both ways");
};

cases["a step moves by one notch from wherever it is"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    run.calls.length = 0;
    control.step(true);
    Harness.equal(run.calls[0], "ddcutil --display 1 setvcp 10 45", "up from 40");
    control.step(false);
    Harness.equal(run.calls[2], "ddcutil --display 1 setvcp 10 40", "and back down");
};

cases["a destroyed control stops claiming anything"] = function () {
    let run = detecting(DETECT_TWO, 0);
    let control = new Ddc.DdcBacklight(null, null, run);
    control.start();
    Harness.equal(control.available, true, "before");
    control.destroy();
    Harness.equal(control.available, false, "after");
    run.calls.length = 0;
    control.setPercentage(10);
    Harness.deepEqual(run.calls, [], "and does not spawn anything else");
};

cases["a read is not started while a write is in flight"] = function () {
    let calls = [];
    let waiting = [];
    let control = new Ddc.DdcBacklight(null, null, function (argv, onDone) {
        calls.push(argv.join(" "));
        waiting.push(onDone);
    });
    control.displays = ["1"];

    control.setPercentage(40, () => {});
    Harness.equal(calls.length, 1, "the write went out");

    let answered = false;
    control.refresh(() => { answered = true; });
    Harness.equal(calls.length, 1, "and no read went out behind it");
    Harness.equal(answered, true, "but the caller was still answered");

    waiting.shift()("", 0);
    control.refresh(() => {});
    Harness.equal(calls.length, 2, "once the write is done, a read goes out again");
    control.destroy();
};
