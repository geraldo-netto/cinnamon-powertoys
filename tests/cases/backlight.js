/*
 * The screen and keyboard backlights, against a stubbed settings daemon.
 *
 * The proxy is a parameter now, so these run with no session bus and no
 * csd-power. Before that the only thing exercising this module was the case
 * that loads it, which is to say nothing: a renamed method, a percentage read
 * out of the wrong place in the reply, a signal never connected - none of it
 * would have failed anywhere.
 *
 * The stub answers the way the daemon does: every remote call hands back an
 * array, because that is what a D-Bus reply unpacks to even when it carries
 * one value, and that array is exactly where two of these bugs would live.
 */

const Harness = imports.harness;

const Backlight = Harness.requireXlet("./lib/backlight.js");

/*
 * A settings daemon proxy. `answers` says what each call returns; a value of
 * null makes that call fail, which is how a machine with the interface and no
 * backlight behind it answers.
 */
function proxy(answers, options) {
    let settings = options || {};
    let calls = [];
    let handlers = {};

    function remote(name) {
        return function () {
            let args = Array.prototype.slice.call(arguments);
            let onDone = args.pop();
            calls.push([name].concat(args));
            let answer = answers[name];
            if (answer === null || answer === undefined)
                onDone(null, new Error(name + " is not available"));
            else
                onDone([answer], null);
        };
    }

    let stub = {
        calls: calls,
        handlers: handlers,
        GetPercentageRemote: remote("GetPercentage"),
        SetPercentageRemote: remote("SetPercentage"),
        StepUpRemote: remote("StepUp"),
        StepDownRemote: remote("StepDown"),
        connectSignal: function (name, handler) {
            handlers[name] = handler;
            return 7;
        },
        disconnectSignal: function (id) {
            calls.push(["disconnectSignal", id]);
        },
    };
    if (settings.toggle !== false)
        stub.ToggleRemote = remote("Toggle");
    return stub;
}

/* A control wired to a stub, with the answer already in hand: the stubbed
 * connect calls back before it returns, so nothing here waits. */
function control(kind, stub, error) {
    let ready = 0;
    let changed = 0;
    let backlight = new Backlight.BacklightControl(
        kind, () => changed++, () => ready++,
        (xml, onDone) => onDone(error ? null : stub, error || null));
    backlight.readyCount = () => ready;
    backlight.changedCount = () => changed;
    return backlight;
}

var cases = {};

cases["a backlight answers with what the daemon reports"] = function () {
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 42 }));
    Harness.equal(screen.available, true, "the daemon answered, so there is one");
    Harness.equal(screen.percentage, 42, "and this is where it is");
    Harness.equal(screen.readyCount(), 1, "ready is said once, when the answer is in");
};

cases["an interface with no backlight behind it is not available"] = function () {
    /* csd exports Power.Screen on a desktop too, and answers it with an
     * error. That error is the answer to "is there one", not a failure. */
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: null }));
    Harness.equal(screen.available, false, "nothing behind it");
    Harness.equal(screen.percentage, null, "so no value to show");
    Harness.equal(screen.readyCount(), 1, "and the caller is told, or it waits for ever");
};

cases["a daemon that will not connect is not available"] = function () {
    let screen = control(Backlight.SCREEN, null, new Error("no such name"));
    Harness.equal(screen.available, false, "no proxy");
    Harness.equal(screen.readyCount(), 1, "still answered");
};

cases["a kind this module does not know is ready at once"] = function () {
    let odd = control("fingerprint-reader", proxy({ GetPercentage: 50 }));
    Harness.equal(odd.available, false, "there is no interface for it");
    Harness.equal(odd.readyCount(), 1, "and the caller is not left waiting on one");
};

cases["a value is clamped and rounded before it is sent"] = function () {
    let stub = proxy({ GetPercentage: 40, SetPercentage: 45 });
    let screen = control(Backlight.SCREEN, stub);
    screen.setPercentage(44.6);
    screen.setPercentage(140);
    screen.setPercentage(-3);
    Harness.deepEqual(stub.calls.filter(call => call[0] === "SetPercentage"),
                      [["SetPercentage", 45], ["SetPercentage", 100], ["SetPercentage", 0]],
                      "the daemon takes a whole percentage in range");
};

cases["what the daemon set is what is kept, not what was asked for"] = function () {
    /* Some panels have far fewer steps than a hundred, so the daemon answers
     * with where the backlight actually ended up. */
    let screen = control(Backlight.SCREEN, proxy({ GetPercentage: 40, SetPercentage: 33 }));
    screen.setPercentage(37);
    Harness.equal(screen.percentage, 33, "the daemon's number, not the slider's");
};

cases["a step is the daemon's own notch"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 50, StepDown: 30 });
    let screen = control(Backlight.SCREEN, stub);
    screen.step(true);
    Harness.equal(screen.percentage, 50, "up");
    screen.step(false);
    Harness.equal(screen.percentage, 30, "down");
    Harness.deepEqual(stub.calls.filter(call => call[0].indexOf("Step") === 0),
                      [["StepUp"], ["StepDown"]],
                      "no size is passed, because the size is the daemon's business");
};

cases["only the keyboard has a toggle"] = function () {
    let keyboard = control(Backlight.KEYBOARD, proxy({ GetPercentage: 60, Toggle: 0 }));
    keyboard.toggle();
    Harness.equal(keyboard.percentage, 0, "off, and it says where it went");

    let stub = proxy({ GetPercentage: 60 }, { toggle: false });
    let screen = control(Backlight.SCREEN, stub);
    screen.toggle();
    Harness.deepEqual(stub.calls.filter(call => call[0] === "Toggle"), [],
                      "the screen interface has no such call and must not be asked for it");
};

cases["something else moving the backlight is read and reported"] = function () {
    /* A function key, or the daemon dimming on idle. The value is re-read
     * rather than assumed, because the signal carries nothing. */
    let stub = proxy({ GetPercentage: 40 });
    let screen = control(Backlight.SCREEN, stub);
    Harness.equal(screen.changedCount(), 0, "nothing has happened yet");

    stub.calls.length = 0;
    stub.GetPercentageRemote = (onDone) => onDone([15], null);
    stub.handlers.Changed();

    Harness.equal(screen.percentage, 15, "read again rather than guessed");
    Harness.equal(screen.changedCount(), 1, "and passed on once");
};

cases["a destroyed control lets go and stops answering"] = function () {
    let stub = proxy({ GetPercentage: 40 });
    let screen = control(Backlight.SCREEN, stub);
    screen.destroy();
    Harness.equal(screen.available, false, "not available once it is gone");
    Harness.deepEqual(stub.calls.filter(call => call[0] === "disconnectSignal"),
                      [["disconnectSignal", 7]], "the Changed handler goes with it");

    stub.calls.length = 0;
    screen.setPercentage(50);
    screen.step(true);
    Harness.deepEqual(stub.calls, [],
                      "and nothing reaches a daemon on behalf of an applet that has left");
};

cases["every call answers its caller, even where there is nothing to call"] = function () {
    /*
     * The contract this class shares with lib/ddc.js, which counts callbacks
     * down to know when a group of monitors has finished. A control that says
     * nothing when there is no proxy behind it is one a counting caller waits
     * on for ever.
     */
    let screen = control(Backlight.SCREEN, null, new Error("no such name"));
    let answered = 0;
    screen.refresh(() => answered++);
    screen.setPercentage(50, () => answered++);
    screen.toggle(() => answered++);
    screen.stepBy(2, () => answered++);
    Harness.equal(answered, 4, "no proxy is an answer, not a silence");
};

cases["a call in flight when the applet leaves still answers"] = function () {
    /* The other way out that said nothing: the applet is removed while the
     * daemon is thinking about it, and whoever asked is still counting.
     * Destroyed on the way out, as removing the applet mid-call would. */
    let stub = proxy({ GetPercentage: 40, SetPercentage: 70, Toggle: 0 });
    let screen = control(Backlight.KEYBOARD, stub);

    let answered = 0;
    for (let name of ["GetPercentageRemote", "SetPercentageRemote", "ToggleRemote"]) {
        let real = stub[name];
        stub[name] = function () {
            screen.destroyed = true;
            return real.apply(stub, arguments);
        };
    }

    screen.refresh(() => answered++);
    screen.setPercentage(70, () => answered++);
    screen.toggle(() => answered++);
    Harness.equal(answered, 3, "a reply for an applet that has gone is still a reply");
};

cases["a gathered flick is that many of the daemon's own notches"] = function () {
    /*
     * Not turned into a percentage: the notch is the daemon's to size and it
     * is the same one the brightness keys use, which is the whole reason this
     * goes through the daemon rather than writing sysfs.
     */
    let stub = proxy({ GetPercentage: 40, StepUp: 55, StepDown: 25 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;

    screen.stepBy(3);
    Harness.deepEqual(stub.calls, [["StepUp"], ["StepUp"], ["StepUp"]],
                      "three notches, one after another");
    Harness.equal(screen.percentage, 55, "and it ends where the daemon says it ended");

    stub.calls.length = 0;
    screen.stepBy(-2);
    Harness.deepEqual(stub.calls, [["StepDown"], ["StepDown"]], "and down the same way");
};

cases["a flick that gathered to nothing does nothing"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 45 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;
    screen.stepBy(0);
    Harness.deepEqual(stub.calls, [], "up and back down again is where it started");
};

cases["a destroyed control stops part way through a flick"] = function () {
    let stub = proxy({ GetPercentage: 40, StepUp: 45 });
    let screen = control(Backlight.SCREEN, stub);
    stub.calls.length = 0;

    /* Destroy on the first answer, as removing the applet mid-flick would. */
    let real = stub.StepUpRemote;
    stub.StepUpRemote = onDone => { screen.destroy(); real(onDone); };
    screen.stepBy(5);
    Harness.deepEqual(stub.calls.filter(call => call[0] === "StepUp"), [["StepUp"]],
                      "the notch that was already out, and none of the four behind it");
};
