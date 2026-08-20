/*
 * What a wheel notch or a middle click over the panel icon amounts to.
 *
 * This routing was on the applet, so the one thing every input path shares -
 * that it is answered against what the machine can do at the moment of the
 * event, not at the moment the applet was built - could only be seen on a
 * running session. Clutter's two handler return values and its direction
 * enumeration are ports, so a notch can be driven here without a stage.
 */

const Harness = imports.harness;

const InputRouting = Harness.requireXlet("./lib/input-routing.js");

var cases = {};

const STOP = "stop";
const PROPAGATE = "propagate";
const DIRECTIONS = { UP: "up", DOWN: "down", SMOOTH: "smooth" };

/* A settle window a case can close on demand rather than wait a quarter of a
 * second for. */
function timers() {
    let pending = {};
    let next = 1;
    return {
        port: {
            add: (delay, callback) => {
                pending[next] = callback;
                return next++;
            },
            remove: id => { delete pending[id]; },
        },
        settle: () => {
            for (let id in pending) {
                let callback = pending[id];
                delete pending[id];
                callback();
            }
        },
        outstanding: () => Object.keys(pending).length,
    };
}

function rig(options) {
    options = options || {};
    let clock = timers();
    let log = { brightness: [], keyboard: 0, steps: [], cycles: 0, redraws: 0 };
    let screen = options.screen === undefined
        ? { available: true, stepBy: (n, done) => { log.brightness.push(["screen", n]); done(); } }
        : options.screen;
    let monitor = options.monitor === undefined
        ? { available: false, stepBy: (n, done) => { log.brightness.push(["monitor", n]); done(); } }
        : options.monitor;
    let keyboard = options.keyboard === undefined
        ? { available: true, toggle: done => { log.keyboard += 1; done(); } }
        : options.keyboard;
    log.backlights = { screen: screen, monitor: monitor, keyboard: keyboard };
    log.external = !!options.external;
    log.scrollAction = options.scrollAction || "brightness";
    log.middleClickAction = options.middleClickAction || "keyboard-backlight";
    log.profile = options.profile !== false;
    let router = new InputRouting.InputRouter({
        stop: STOP,
        propagate: PROPAGATE,
        scrollDirection: DIRECTIONS,
        timers: clock.port,
        scrollAction: () => log.scrollAction,
        middleClickAction: () => log.middleClickAction,
        backlights: () => log.backlights,
        externalDisplayMode: () => log.external,
        onBacklightChanged: () => { log.redraws += 1; },
        profileSteppable: () => log.profile,
        stepProfile: notches => log.steps.push(notches),
        cycleProfile: () => { log.cycles += 1; },
    });
    return { router: router, log: log, clock: clock };
}

function wheel(direction) {
    return {
        get_scroll_direction: () => direction,
        get_scroll_delta: () => [0, 0],
    };
}

function button(number) {
    return { get_button: () => number };
}

cases["a scroll that points nowhere is left to whoever else wants it"] = function () {
    let it = rig();
    Harness.equal(it.router.onScroll(null, wheel("sideways")), PROPAGATE,
                  "an unreadable direction is not this applet's event");
    Harness.equal(it.clock.outstanding(), 0, "and nothing was gathered");
};

cases["a wheel the machine cannot answer propagates rather than swallowing"] = function () {
    let it = rig({ screen: null, monitor: null });
    Harness.equal(it.router.onScroll(null, wheel("up")), PROPAGATE,
                  "a desktop with no backlight does not eat the scroll");
    it.log.scrollAction = "profile";
    it.log.profile = false;
    Harness.equal(it.router.onScroll(null, wheel("up")), PROPAGATE,
                  "and neither does a machine with no profile to step");
};

cases["a flick is one write, not five"] = function () {
    let it = rig();
    for (let i = 0; i < 5; i++)
        Harness.equal(it.router.onScroll(null, wheel("up")), STOP, "each notch is claimed");
    Harness.deepEqual(it.log.brightness, [], "nothing is written while the flick is going on");
    it.clock.settle();
    Harness.deepEqual(it.log.brightness, [["screen", 5]],
                      "and the whole flick lands as one step of five");
    Harness.equal(it.log.redraws, 1, "with one redraw for it");
};

cases["a flick down is as many steps as the same flick up"] = function () {
    let it = rig();
    it.router.onScroll(null, wheel("down"));
    it.router.onScroll(null, wheel("down"));
    it.clock.settle();
    Harness.deepEqual(it.log.brightness, [["screen", -2]], "two notches down is minus two");
};

cases["a flick is resolved where it settles, not where it started"] = function () {
    let it = rig();
    it.router.onScroll(null, wheel("up"));
    /* The lid closes, or a monitor is plugged in, in the quarter second
     * between the flick and its settling. */
    it.log.external = true;
    it.log.backlights.monitor.available = true;
    it.clock.settle();
    Harness.deepEqual(it.log.brightness, [["monitor", 1]],
                      "the notch reached the screen that was in use when it landed");
};

cases["a flick whose screen went away lands on nothing rather than throwing"] = function () {
    let it = rig();
    it.router.onScroll(null, wheel("up"));
    it.log.backlights = {};
    it.clock.settle();
    Harness.deepEqual(it.log.brightness, [], "there was nothing left to step");
    Harness.equal(it.log.redraws, 0, "and nothing to redraw");
};

cases["a profile wheel steps and does not gather into brightness"] = function () {
    let it = rig({ scrollAction: "profile" });
    it.router.onScroll(null, wheel("up"));
    it.router.onScroll(null, wheel("up"));
    it.clock.settle();
    Harness.deepEqual(it.log.steps, [2], "two notches is one step of two");
    Harness.deepEqual(it.log.brightness, [], "and no brightness was touched");
};

cases["a closed lid follows the display topology rather than the panel"] = function () {
    let it = rig({ external: true });
    /* The panel is closed but its kernel backlight still answers; the monitor
     * on the cable has not answered yet. */
    Harness.equal(it.router.brightnessControl(), null,
                  "no silent write to a screen nobody can see");
    Harness.equal(it.router.capabilities().brightness, false,
                  "which the wheel is told about");
};

cases["what the machine can do is asked at the moment of the event"] = function () {
    let it = rig();
    Harness.equal(it.router.capabilities().keyboardBacklight, true,
                  "the keyboard backlight answers now");
    it.log.backlights.keyboard.available = false;
    Harness.equal(it.router.capabilities().keyboardBacklight, false,
                  "and does not a moment later");
    it.log.backlights = {};
    Harness.deepEqual(it.router.capabilities(),
                      { brightness: false, keyboardBacklight: false, profile: true },
                      "an empty bag is answered rather than reached into");
};

cases["only the middle button is this applet's"] = function () {
    let it = rig();
    Harness.equal(it.router.onButtonPress(null, button(1)), PROPAGATE, "left click is not");
    Harness.equal(it.router.onButtonPress(null, button(3)), PROPAGATE, "right click is not");
    Harness.equal(it.log.keyboard, 0, "and neither toggled anything");
};

cases["a middle click toggles the keyboard backlight"] = function () {
    let it = rig();
    Harness.equal(it.router.onButtonPress(null, button(2)), STOP, "the event is claimed");
    Harness.equal(it.log.keyboard, 1, "the backlight was toggled");
    Harness.equal(it.log.redraws, 1, "and the change was drawn");
};

cases["a middle click set to profile cycles it"] = function () {
    let it = rig({ middleClickAction: "profile" });
    Harness.equal(it.router.onButtonPress(null, button(2)), STOP, "the event is claimed");
    Harness.equal(it.log.cycles, 1, "and the profile came round one");
};

cases["a middle click the machine cannot answer propagates"] = function () {
    let it = rig({ keyboard: { available: false, toggle: () => {} } });
    Harness.equal(it.router.onButtonPress(null, button(2)), PROPAGATE,
                  "a machine with no keyboard backlight does not eat the click");
    it.log.middleClickAction = "profile";
    it.log.profile = false;
    Harness.equal(it.router.onButtonPress(null, button(2)), PROPAGATE,
                  "and neither does one with no profile to cycle");
};

cases["a flick that has not settled when the applet goes is dropped"] = function () {
    let it = rig();
    it.router.onScroll(null, wheel("up"));
    Harness.equal(it.clock.outstanding(), 1, "a settle window is open");
    it.router.cancel();
    Harness.equal(it.clock.outstanding(), 0, "and it is closed by teardown");
    it.clock.settle();
    Harness.deepEqual(it.log.brightness, [],
                      "nothing is applied to a control being taken apart");
};

cases["a router with no ports at all does not throw"] = function () {
    let router = new InputRouting.InputRouter();
    Harness.equal(router.onScroll(null, wheel("up")), undefined,
                  "with no direction enumeration the scroll reads as nothing");
    Harness.equal(router.onButtonPress(null, button(2)), undefined,
                  "and there is no action a default router can take");
    Harness.equal(router.brightnessControl(), null, "no screen to step");
    router.stepBrightness(1);
    router.cancel();
};
