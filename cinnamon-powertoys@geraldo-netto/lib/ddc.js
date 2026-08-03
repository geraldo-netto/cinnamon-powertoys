/*
 * cinnamon-powertoys - external monitor brightness, over DDC/CI.
 *
 * A laptop's own panel has a kernel backlight device and belongs to
 * cinnamon-settings-daemon, which lib/backlight.js talks to. A monitor on a
 * cable has no such device: the only way to move its backlight is to send it
 * DDC/CI over the display's I2C channel, and in practice that means ddcutil.
 *
 * Every call spawns a process and can take a few hundred milliseconds - some
 * monitors are slow to answer and a few never do - so nothing here is
 * synchronous and nothing blocks the shell. A missing ddcutil, no permission
 * on /dev/i2c-*, or a display that simply does not reply all end in the same
 * place: available stays false and the caller shows nothing.
 *
 * Probing is not free and can wake a sleeping monitor, so the caller is
 * expected to ask for this only where there is no kernel backlight to use
 * instead.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Hardware = require("./lib/hardware.js");
const Log = require("./lib/log.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/* The DDC/CI feature code for backlight. Every monitor that supports any of
 * this supports 0x10. */
var BRIGHTNESS_FEATURE = "10";

/* Long enough for a slow monitor, short enough that a monitor which never
 * answers does not leave a process behind for the session. */
var CALL_TIMEOUT_MS = 8000;

/* One notch, matching what the brightness keys do elsewhere. */
var STEP = 5;

/*
 * How many monitors get a slider of their own.
 *
 * Every one of them is a ddcutil process per refresh, against hardware that
 * answers in tenths of a second, so this is a real cost and not a display
 * limit. Ten is past any desk and short of a video wall, and the menu says
 * when it has been reached rather than quietly dropping what is over it.
 */
var MAX_DISPLAYS = 10;

/*
 * Runs a command and hands back its output. Gio.Subprocess rather than
 * Cinnamon's spawn helpers, so this module stays loadable outside the shell,
 * and with a timer behind it because ddcutil can hang on a monitor that
 * accepts the connection and then says nothing.
 */
function runCommand(argv, onDone) {
    let done = false;
    let timeoutId = 0;
    let process;

    function finish(output, status) {
        if (done)
            return;
        done = true;
        /* The timer has done its job, or never needed to; either way it is
         * not left armed for the rest of its eight seconds. */
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        onDone(output, status);
    }

    try {
        process = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        process.init(null);
    } catch (error) {
        /* ddcutil is not installed, which is the ordinary case. */
        finish("", -1);
        return;
    }

    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALL_TIMEOUT_MS, () => {
        timeoutId = 0;
        Log.error("ddcutil did not answer in time, giving up on it");
        try {
            process.force_exit();
        } catch (e) {
            /* already gone */
        }
        finish("", -1);
        return GLib.SOURCE_REMOVE;
    });

    process.communicate_utf8_async(null, null, (source, result) => {
        try {
            let [, stdout] = source.communicate_utf8_finish(result);
            finish(stdout || "", source.get_exit_status());
        } catch (error) {
            finish("", -1);
        }
    });
}

/*
 * What "ddcutil --brief detect" says about one display, per display.
 *
 * The number is what --display wants. The rest is what makes a slider mean
 * something to whoever is looking at it: the monitor line is the EDID
 * manufacturer code, model and serial, and the DRM connector is which socket
 * on which card it is plugged into - the fallback for two identical monitors,
 * which report identical everything else.
 *
 * "Invalid display" blocks are a display the tool can see and cannot talk
 * DDC/CI to. They carry the same fields, so they have to be recognised rather
 * than parsed hopefully.
 */
function parseDisplays(output) {
    let displays = [];
    let current = null;

    for (let line of String(output || "").split("\n")) {
        let start = /^Display\s+(\d+)\s*$/.exec(line);
        if (start) {
            current = { number: start[1], bus: null, connector: null,
                        manufacturer: "", model: "", serial: "" };
            displays.push(current);
            continue;
        }
        /* Anything that is not indented ends the block, which is how an
         * "Invalid display" heading stops the fields under it being read as
         * the previous display's. */
        if (!/^\s/.test(line)) {
            current = null;
            continue;
        }
        if (!current)
            continue;

        let field = /^\s+([^:]+):\s+(.*?)\s*$/.exec(line);
        if (!field)
            continue;
        if (field[1] === "I2C bus")
            current.bus = field[2];
        else if (field[1] === "DRM connector")
            current.connector = field[2];
        else if (field[1] === "Monitor") {
            let parts = field[2].split(":");
            current.manufacturer = (parts[0] || "").trim();
            current.model = (parts[1] || "").trim();
            current.serial = (parts[2] || "").trim();
        }
    }

    return displays;
}

/* card2-HDMI-A-2 is the kernel's name for a socket; HDMI-A-2 is the socket. */
function _connectorName(connector) {
    if (!connector)
        return null;
    return connector.replace(/^card\d+-/, "");
}

/*
 * A name for each display, and a way of telling two of the same apart.
 *
 * The serial number would do it and is deliberately not used: it identifies a
 * particular piece of hardware, it is in every screenshot of the menu anyone
 * ever posts, and it is no help at all in working out which of the two
 * monitors on the desk is which. Which socket it is plugged into is.
 */
function nameDisplays(displays) {
    let named = displays.map(display => Object.assign({}, display, {
        name: Hardware.monitorName(display.manufacturer, display.model) ||
              _connectorName(display.connector) ||
              _("Display") + " " + display.number,
    }));

    let counts = {};
    for (let display of named)
        counts[display.name] = (counts[display.name] || 0) + 1;

    return named.map(function (display) {
        if (counts[display.name] < 2)
            return display;
        let apart = _connectorName(display.connector) || display.number;
        return Object.assign({}, display, { name: display.name + " (" + apart + ")" });
    });
}

/*
 * "VCP 10 C 40 100" - feature, type, current, maximum. The maximum is not
 * always 100, so the percentage has to be worked out rather than assumed.
 */
function parseBrightness(output) {
    let match = /^VCP\s+10\s+\S+\s+(\d+)\s+(\d+)/m.exec(output || "");
    if (!match)
        return null;
    let current = Number(match[1]);
    let maximum = Number(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0)
        return null;
    return Math.round(current / maximum * 100);
}

/*
 * One monitor.
 *
 * It answers to the same handful of members a kernel backlight does -
 * available, percentage, refresh, setPercentage, step - so a slider does not
 * know or care which kind of screen it is moving.
 */
var DdcMonitor = class DdcMonitor {
    constructor(display, run) {
        this.id = display.bus || ("display:" + display.number);
        this.number = display.number;
        this.name = display.name;
        this.available = false;
        this.percentage = null;
        this.destroyed = false;
        /* Whether this monitor has ever answered. See refresh(). */
        this.known = false;

        this._run = run;
        /* One ddcutil at a time for this monitor, read or write. See refresh. */
        this._busy = false;
        /* The one value asked for while that was true. See setPercentage. */
        this._held = null;
    }

    /*
     * Whether ddcutil is talking to this monitor right now, either way round.
     *
     * The flag has always existed to keep this monitor's own calls off each
     * other's toes; what reads it from outside is the group, which has to
     * know whether a probe would land on top of one. See DdcBacklight.busy.
     */
    get busy() {
        return this._busy;
    }

    /* Kept across a re-detection: the display number ddcutil hands out is a
     * position in its own list and moves when something else is unplugged,
     * and the name can change when a monitor is switched for another on the
     * same socket. What does not change is the bus, which is the id. */
    adopt(display) {
        this.number = display.number;
        this.name = display.name;
    }

    /*
     * One conversation with this monitor at a time, whichever kind.
     *
     * Reading is skipped while a write is in flight, because the value being
     * asked for is about to be overwritten by the write anyway - and, more to
     * the point, asking a monitor two things at once over a bus it answers in
     * tenths of a second is how ddcutil comes back with nothing.
     *
     * That second reason is the whole reason, and it applies just as much to
     * two reads. This checked the flag and never set it, so it was the one
     * call that could overlap itself: opening the menu twice inside a probe's
     * round trip refreshes every backlight again, and a monitors-changed
     * re-detection can land on top of a menu open. What came back from that
     * was nothing, which on a monitor that has answered before is silently
     * kept as the value it had - so a bus collision looked exactly like a
     * monitor that had gone to sleep.
     */
    refresh(onDone) {
        let done = onDone || function () {};
        if (this.destroyed || this._busy) {
            done();
            return;
        }
        this._busy = true;
        this._run(["ddcutil", "--brief", "--display", this.number,
                   "getvcp", BRIGHTNESS_FEATURE], (output, status) => {
            this._busy = false;
            if (this.destroyed) {
                done();
                return;
            }
            let value = status === 0 ? parseBrightness(output) : null;
            if (value !== null) {
                this.known = true;
                this.available = true;
                this.percentage = value;
            } else if (!this.known) {
                this.available = false;
                this.percentage = null;
            }
            /*
             * A monitor that has answered before and misses one read is
             * asleep, or busy answering something else on the same bus - not
             * gone. Taking the slider away for that meant a row vanishing and
             * coming back under the pointer, and a drag in progress thrown
             * away with the widget. The last value stands; moving the slider
             * wakes the monitor, which is what a slider is for. A monitor that
             * really has gone is removed by the next detection.
             */
            done();
            this._writeHeld();
        });
    }

    /*
     * Will not start a second write while something is in flight, and does not
     * throw away what was asked for either.
     *
     * A drag emits a value per motion event, against hardware that answers in
     * tenths of a second, so a process per value the pointer passes through is
     * out of the question - that guard was there from the start. What it did
     * with the value was drop it, and the one a drag ends on is exactly the one
     * most likely to land inside the previous write's round trip: drag to 90,
     * release, and the monitor stops at 65 where the last taken write put it,
     * the number beside the handle agrees, and the next refresh pulls the
     * handle back to match. The wheel met the same arithmetic in PT-136 and
     * answered it by gathering the flick before it got here; a drag has no
     * gather, so the last value is held instead and written when the bus is
     * free. Only the last, because the ones the pointer passed through on the
     * way are not where anybody let go.
     *
     * The value is only taken as this monitor's once ddcutil says it took it.
     * It used to be taken whatever came back, so a write the monitor refused -
     * asleep, switched to its other input, the cable pulled mid-drag - left the
     * slider reading a number the screen was not at. That number then stuck:
     * a monitor that has answered once keeps its last value through a failed
     * read, by design, and the last value was now the wrong one. On a refusal
     * the reading is left where the monitor last put it and the next refresh
     * answers, which is the same thing that happens when a read fails.
     */
    setPercentage(value, onDone) {
        let done = onDone || function () {};
        if (this.destroyed) {
            done();
            return;
        }

        let wanted = Math.max(0, Math.min(100, Math.round(value)));
        if (this._busy) {
            /*
             * The one it replaces is answered now rather than never. Its write
             * is not going out, which is what a refused write already meant to
             * its caller - and the group's setPercentage counts its monitors
             * down to know when it has finished, so a callback that never comes
             * is a count that never reaches zero.
             */
            if (this._held)
                this._held.done();
            this._held = { value: wanted, done: done };
            return;
        }

        this._busy = true;
        this._run(["ddcutil", "--display", this.number,
                   "setvcp", BRIGHTNESS_FEATURE, String(wanted)], (output, status) => {
            this._busy = false;
            if (this.destroyed) {
                done();
                return;
            }
            if (status === 0)
                this.percentage = wanted;
            else
                /* One line per completed write, since _busy serialises them,
                 * and the only trace there is: ddcutil's own complaint goes to
                 * a stderr this module silences. */
                Log.error("ddcutil would not set the brightness of " + this.name +
                          " to " + wanted + "% (exit " + status + ")");
            done();
            this._writeHeld();
        });
    }

    /* Whatever was asked for while the bus was busy, now that it is not.
     * Called wherever _busy comes back down, since a write can be asked for
     * during a read as easily as during another write. */
    _writeHeld() {
        if (this.destroyed || this._busy || !this._held)
            return;
        let held = this._held;
        this._held = null;
        this.setPercentage(held.value, held.done);
    }

    /*
     * Several notches at once, as one write rather than one write per notch.
     *
     * A monitor answers in tenths of a second and a second write while the
     * first is in flight is refused, so a flick sent one notch at a time
     * arrived as one notch and the rest were dropped on the floor. The wheel
     * gathers the flick and this applies the total.
     */
    stepBy(notches, onDone) {
        let from = this.percentage === null ? 50 : this.percentage;
        this.setPercentage(from + notches * STEP, onDone);
    }

    step(up, onDone) {
        this.stepBy(up ? 1 : -1, onDone);
    }

    destroy() {
        this.destroyed = true;
        this.available = false;
        /* A held write is not going out now, and whoever asked for it is still
         * waiting to hear; see the note on answering in setPercentage. */
        let held = this._held;
        this._held = null;
        if (held)
            held.done();
    }
};

/*
 * Every monitor on this machine, and the one control that stands for all of
 * them.
 *
 * Each monitor is its own slider in the menu, because "turn the brightness
 * down" means one screen to somebody with a bright one beside a dim one, and
 * the single slider this replaced could not say which screen it was on or
 * leave them set differently. What is still shared is the wheel over the panel
 * icon, which has no screen in mind and so moves all of them: that gesture
 * happens with the menu shut and nothing on screen to say which monitor it
 * would otherwise have picked.
 */
var DdcBacklight = class DdcBacklight {
    /*
     * onChanged is called whenever the set of monitors or their values changes
     * under this class's own hand: a probe finishing, a re-detection finding
     * something new, the control being stopped. It is the only way the menu
     * hears that a monitor has been plugged in.
     *
     * There were two callbacks here, and the second - onReady - said "the
     * first probe has answered, you can stop wondering whether this machine
     * has any of this". Nothing ever made that distinction: the applet passed
     * the same function for both, because syncing the sliders is all it does
     * on either. Once stop() existed the "first" was not true either, since
     * switching the setting off and on probes again.
     *
     * BacklightControl keeps its own onReady, and there the difference does
     * earn its keep: whether the screen has a kernel backlight is exactly what
     * decides whether this class is ever asked to probe.
     */
    constructor(onChanged, run) {
        this.available = false;
        this.percentage = null;
        this.destroyed = false;
        this.monitors = [];
        /* How many were found beyond MAX_DISPLAYS, so the menu can say so. */
        this.hidden = 0;

        this._onChanged = onChanged || function () {};
        this._run = run || runCommand;
        this._started = false;
        this._detecting = false;
        /* Which probe is the current one; see _detect. */
        this._probe = null;
    }

    /*
     * Probing is deliberately not done on construction. It spawns a process,
     * touches the I2C bus and can wake a sleeping monitor, so the caller
     * decides whether this machine needs it at all - which it only knows once
     * the settings daemon has said whether there is a kernel backlight.
     */
    start() {
        if (this._started || this.destroyed)
            return;
        this._started = true;
        this._detect();
    }

    /*
     * Let every monitor go, and be ready to look again.
     *
     * Not destroy(), which is final and is what leaving the panel calls. This
     * is the setting being switched off, which says stop talking to the I2C
     * bus - not that this control will never be wanted again. Switching it
     * back on probes from scratch, which is the right thing to do rather than
     * a concession: monitors may well have been plugged or unplugged while it
     * was off, and nothing was watching.
     *
     * A probe already in flight is disowned rather than waited for. _detect
     * checks _started when it answers, so the monitors it found are dropped
     * instead of quietly reappearing after the setting said no.
     */
    stop() {
        if (!this._started)
            return;
        this._started = false;
        for (let monitor of this.monitors)
            monitor.destroy();
        this.monitors = [];
        this.hidden = 0;
        this.available = false;
        this.percentage = null;
        /* Emptying the list is a change like any other; see lib/bluez.js,
         * where the same silence kept dead rows in the menu. */
        this._onChanged();
    }

    /*
     * Whether anything of this machine's is on the I2C bus at this moment.
     *
     * There are two conversations here and they were guarded separately: a
     * probe against another probe (_detecting), and one monitor against its own
     * next read or write (_busy, per monitor). Nothing guarded a probe against
     * the reads, and the applet lines those two up as a matter of course -
     * opening the menu refreshes every backlight, which sends a getvcp to every
     * monitor, and then starts the watch, whose first probe goes out at once. A
     * drag does the same once a second: a setvcp in flight, a tick, a detect.
     *
     * A detect walks every bus, so it collides with whatever is on one of them,
     * and two ddcutil talking to one monitor is how ddcutil comes back with
     * nothing - PT-135 and PT-145c met a third time. It heals silently, because
     * a monitor that has answered before keeps its last value through a read
     * that fails, which is exactly what makes it worth closing rather than
     * watching for.
     *
     * So the two guards become one question, asked of the whole machine.
     */
    get busy() {
        if (this._detecting)
            return true;
        return this.monitors.some(monitor => monitor.busy);
    }

    /*
     * Look again, because the screens have changed.
     *
     * Detection used to happen once and never again, so a monitor plugged in,
     * switched on or woken after the applet started had no slider until the
     * applet was reloaded - and one that was asleep when the first probe ran
     * was gone for the session. That was survivable when a single slider stood
     * for every monitor; a list of named ones that silently never grows is
     * not.
     *
     * The caller decides when, and this is deliberately not on the poll: a
     * probe talks to every display on the I2C bus and wakes a sleeping one,
     * which is not something to do every few seconds for no reason. The applet
     * asks when the desktop says a connector changed, and otherwise only while
     * somebody is looking at the applet - see _watchMonitors there, which is
     * also where the reason a hotplug event is not enough on its own is.
     */
    redetect() {
        /* Dropped and not queued whenever ddcutil is already talking to this
         * machine - a probe of its own, or a single monitor being read or
         * written. See busy below, and _detect for the probe's half of it. */
        if (this.destroyed || this.busy)
            return;
        if (!this._started) {
            this.start();
            return;
        }
        this._detect();
    }

    /*
     * The monitors that are there now, keeping the ones that were there
     * before.
     *
     * A monitor is its bus - /dev/i2c-15 - and not its display number, which
     * is a position in ddcutil's own list and shuffles up when something
     * earlier is unplugged. Recognising it means its brightness, its slider
     * and a drag in progress all survive the monitor next to it being
     * switched off.
     */
    _adopt(found) {
        let existing = new Map(this.monitors.map(monitor => [monitor.id, monitor]));
        let monitors = found.map(display => {
            let id = display.bus || ("display:" + display.number);
            let monitor = existing.get(id);
            if (!monitor)
                return new DdcMonitor(display, this._run);
            existing.delete(id);
            monitor.adopt(display);
            return monitor;
        });
        for (let gone of existing.values())
            gone.destroy();
        return monitors;
    }

    /*
     * A probe is the detect and the reads it starts, and it is not over until
     * the reads are back.
     *
     * _detecting used to come down the moment the detect answered, with the
     * getvcp calls that same answer had just sent still out. That was harmless
     * while the only thing asking was a monitor being plugged in, which the
     * desktop says exactly once; a caller that asks every second means the next
     * ask sends a detect across every bus while the last probe is still reading
     * one of them, and two ddcutil talking to one monitor is how ddcutil comes
     * back with nothing - the same collision PT-135 met from the other end.
     *
     * So the flag covers the whole probe, and redetect drops what lands inside
     * one rather than queueing it: whoever asked will ask again a second later,
     * and a queue of probes against hardware that answers in tenths of a second
     * never empties.
     *
     * Which probe is finishing has to be checked, because stop() disowns one
     * rather than waiting for it: switching the setting off and straight back
     * on leaves the old probe to answer whenever it answers, and it must not
     * lower the flag belonging to the probe that has started since.
     */
    _detect() {
        let probe = {};
        this._probe = probe;
        this._detecting = true;
        let settled = () => {
            if (this._probe === probe)
                this._detecting = false;
        };

        this._run(["ddcutil", "--brief", "detect"], (output, status) => {
            /*
             * Stopped while this was in flight: the setting was switched off
             * after the probe went out, and what it found is no longer wanted.
             *
             * Switched off and on again is the same answer for a different
             * reason - _started is true once more, so it takes the token to
             * tell this probe from the one that replaced it, and what an
             * abandoned probe found is a list from before the control was
             * emptied, arriving on top of a fresh one.
             */
            if (this.destroyed || !this._started || this._probe !== probe) {
                settled();
                return;
            }
            if (status !== 0) {
                /* No ddcutil, no permission, or no display answered. */
                settled();
                this._onChanged();
                return;
            }

            let found = nameDisplays(parseDisplays(output));
            this.hidden = Math.max(0, found.length - MAX_DISPLAYS);
            if (this.hidden > 0)
                Log.error("more than " + MAX_DISPLAYS + " monitors answered DDC/CI; " +
                          this.hidden + " of them have no slider");

            this.monitors = this._adopt(found.slice(0, MAX_DISPLAYS));
            if (this.monitors.length === 0) {
                settled();
                this._sync();
                this._onChanged();
                return;
            }
            this.refresh(() => {
                settled();
                this._onChanged();
            });
        });
    }

    /*
     * Every monitor at once rather than one after another. They are on
     * separate buses and do not wait for each other, and a queue of ten
     * monitors that each take a fifth of a second is two seconds of a menu
     * filling in a row at a time.
     */
    refresh(onDone) {
        let done = onDone || function () {};
        let pending = this.monitors.length;
        if (pending === 0) {
            this.available = false;
            done();
            return;
        }

        let settle = () => {
            if (--pending > 0)
                return;
            this._sync();
            done();
        };

        for (let monitor of this.monitors)
            monitor.refresh(settle);
    }

    /* The group stands for whichever monitors answered; the value it reports
     * is the first of them, since that is the one a single figure can mean. */
    _sync() {
        let live = this.monitors.filter(monitor => monitor.available);
        this.available = live.length > 0;
        this.percentage = live.length > 0 ? live[0].percentage : null;
    }

    /*
     * Ask every monitor to move, and answer once the last of them has.
     *
     * They are on separate buses and do not wait for each other, so the count
     * is the only thing that knows when the group has finished - and each
     * monitor answers exactly once whether its write went out, was replaced by
     * a later one or was dropped with the monitor. See DdcMonitor.setPercentage.
     *
     * Every monitor that has ever answered, which is not the same as every
     * monitor in the list. One that has never answered a read has no
     * percentage, so stepBy starts it from 50 - a number from nowhere, sent to
     * hardware that has already declined to talk, refused, and logged a line
     * for it once per flick of the wheel. The menu draws the same line and has
     * from the start: a monitor that has never answered is not offered a
     * slider. Writing to a monitor to wake it is the slider's business, and a
     * monitor with no slider was never dragged.
     */
    _moveEach(ask, onDone) {
        let done = onDone || function () {};
        let targets = this.monitors.filter(monitor => monitor.known);
        let pending = targets.length;
        if (pending === 0) {
            done();
            return;
        }

        let settle = () => {
            if (--pending > 0)
                return;
            if (this.destroyed) {
                done();
                return;
            }
            this._sync();
            done();
        };

        for (let monitor of targets)
            ask(monitor, settle);
    }

    /* One value, on every screen. A number is a number wherever it is sent,
     * which is why this one does not step: there is no such thing as 70%
     * relative to where each screen already was. */
    setPercentage(value, onDone) {
        this._moveEach((monitor, settle) => monitor.setPercentage(value, settle), onDone);
    }

    /*
     * Every monitor by the same count, each from where it is.
     *
     * This used to take the group's own percentage - which is the first
     * monitor that answered, not a fact about any of the others - add the
     * notches, and broadcast that one absolute value to all of them. A bright
     * screen beside a dim one was flattened to the bright one's value by a
     * single flick of the wheel, and the whole reason there is a slider per
     * monitor is that the two can be left set differently.
     *
     * The notch is the same everywhere; where it starts from is each monitor's
     * own business. See DdcMonitor.stepBy.
     */
    stepBy(notches, onDone) {
        this._moveEach((monitor, settle) => monitor.stepBy(notches, settle), onDone);
    }

    step(up, onDone) {
        this.stepBy(up ? 1 : -1, onDone);
    }

    destroy() {
        this.destroyed = true;
        this.available = false;
        for (let monitor of this.monitors)
            monitor.destroy();
        this.monitors = [];
    }
};
