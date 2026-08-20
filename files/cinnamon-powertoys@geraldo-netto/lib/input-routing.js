/*
 * What a wheel notch or a middle click over the panel icon amounts to.
 *
 * lib/input.js already holds the arithmetic - which way a scroll event points,
 * and which of the two actions a setting asks for on a machine that can only
 * do one of them - and lib/scroll-gatherer.js already holds the gathering that
 * turns a flick into one write instead of five. The routing between them was
 * the third part of the same subject and the part no case could reach, because
 * it was on the applet class: a wheel over a panel icon needs a Clutter event
 * and a stage to have come from.
 *
 * Clutter is not imported here. The two return values a Cinnamon event handler
 * must produce, and the direction enumeration a scroll event is read against,
 * are passed in - which is what lets a case drive a notch without a compositor
 * underneath it, and is the same reason lib/scroll-gatherer.js takes its
 * timers rather than reaching for them.
 */

const Backlight = require("./lib/backlight.js");
const Input = require("./lib/input.js");
const ScrollGatherer = require("./lib/scroll-gatherer.js");

const InputRouter = class InputRouter {
    /*
     * Ports, all optional:
     *
     *   stop, propagate    what a handler returns to claim an event or to let
     *                      it past - Clutter.EVENT_STOP and EVENT_PROPAGATE
     *   scrollDirection    Clutter.ScrollDirection, read by lib/input.js
     *   scrollAction()     the wheel setting
     *   middleClickAction()  the middle-click setting
     *   backlights()       the bag of controls: screen, monitor, keyboard.
     *                      Read on every event rather than captured, because a
     *                      monitor can be unplugged and a probe can finish
     *                      while the applet is on the panel
     *   externalDisplayMode()  whether the built-in panel is the screen in use
     *   onBacklightChanged()   a brightness moved; redraw
     *   profileSteppable()     whether a profile may be stepped at all
     *   stepProfile(notches)   one or more steps along the profile list
     *   cycleProfile()         round the list, wrapping
     *   timers, settleMs   handed straight to the gatherer
     */
    constructor(ports) {
        ports = ports || {};
        this._stop = ports.stop;
        this._propagate = ports.propagate;
        this._scrollDirection = ports.scrollDirection || {};
        this._scrollAction = ports.scrollAction || function () { return null; };
        this._middleClickAction = ports.middleClickAction || function () { return null; };
        this._backlights = ports.backlights || function () { return {}; };
        this._externalDisplayMode = ports.externalDisplayMode ||
            function () { return false; };
        this._onBacklightChanged = ports.onBacklightChanged || function () {};
        this._profileSteppable = ports.profileSteppable || function () { return false; };
        this._stepProfile = ports.stepProfile || function () {};
        this._cycleProfile = ports.cycleProfile || function () {};

        /* What to do with the settled count is decided when it settles, not
         * when the flick starts: the gatherer counts notches and knows nothing
         * about what they are for. */
        this._apply = null;
        this._scroll = new ScrollGatherer.ScrollGatherer({
            settleMs: ports.settleMs || ScrollGatherer.SETTLE_MS,
            timers: ports.timers,
            apply: steps => {
                if (this._apply)
                    this._apply(steps);
            },
        });
    }

    /*
     * The wheel counts, and the count is applied once it settles.
     *
     * Three clicks in one direction means three steps, clamped at the ends -
     * the wheel should stop at performance rather than come round again at
     * power saver - and it reaches the daemon as one write instead of three.
     */
    onScroll(actor, event) {
        let amount = Input.scrollAmount(event, this._scrollDirection);
        if (amount === 0)
            return this._propagate;

        /* Which of the two the setting asks for, and whether this machine can
         * do it, is lib/input.js. The brightness notch is the control's own,
         * so on a kernel backlight this moves by the same amount the
         * brightness keys do; the profile step is announced, because the panel
         * is not necessarily showing the profile and otherwise nothing would
         * say it had changed. */
        switch (Input.wheelAction(this._scrollAction(), this.capabilities())) {
            case "brightness":
                this._gather(amount, notches => this.stepBrightness(notches));
                return this._stop;
            case "profile":
                this._gather(amount, notches => this._stepProfile(notches));
                return this._stop;
            default:
                return this._propagate;
        }
    }

    /* Middle click. The stock applet toggles the keyboard backlight, which is
     * the sort of thing nobody discovers but everybody who knew about it
     * misses; what the setting means is lib/input.js. */
    onButtonPress(actor, event) {
        if (event.get_button() !== 2)
            return this._propagate;

        switch (Input.middleClickAction(this._middleClickAction(),
                                        this.capabilities())) {
            case "keyboard-backlight":
                this._backlights().keyboard.toggle(() => this._onBacklightChanged());
                return this._stop;
            case "profile":
                this._cycleProfile();
                return this._stop;
            default:
                return this._propagate;
        }
    }

    /* What this machine can actually be asked to do with a wheel or a middle
     * click, at this moment: a monitor can be unplugged and a profile daemon
     * can go away while the applet is on the panel. */
    capabilities() {
        let backlights = this._backlights() || {};
        return {
            brightness: !!this.brightnessControl(),
            keyboardBacklight: !!(backlights.keyboard && backlights.keyboard.available),
            profile: !!this._profileSteppable(),
        };
    }

    /* Whichever screen this machine actually has: its own visible panel, or a
     * monitor on a cable. A closed panel can still report a working kernel
     * backlight, so topology takes precedence over availability here. */
    brightnessControl() {
        let backlights = this._backlights() || {};
        return Backlight.visibleBacklightControl(
            backlights.screen, backlights.monitor, this._externalDisplayMode());
    }

    /*
     * A gathered flick, on whichever screen this machine has.
     *
     * Resolved when the flick settles rather than when it started: a monitor
     * can be unplugged, or a probe can finish, in the quarter second between.
     */
    stepBrightness(notches) {
        let control = this.brightnessControl();
        if (control)
            control.stepBy(notches, () => this._onBacklightChanged());
    }

    /* Teardown: the gatherer holds a timer, and a flick that has not settled
     * when the applet leaves the panel is dropped rather than applied to a
     * control that is being taken apart. */
    cancel() {
        this._scroll.cancel();
        this._apply = null;
    }

    _gather(step, apply) {
        this._apply = apply;
        this._scroll.gather(step);
    }
};
