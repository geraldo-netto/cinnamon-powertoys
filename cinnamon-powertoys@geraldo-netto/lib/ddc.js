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

const Log = require("./lib/log.js");

/* The DDC/CI feature code for backlight. Every monitor that supports any of
 * this supports 0x10. */
var BRIGHTNESS_FEATURE = "10";

/* Long enough for a slow monitor, short enough that a monitor which never
 * answers does not leave a process behind for the session. */
var CALL_TIMEOUT_MS = 8000;

/* One notch, matching what the brightness keys do elsewhere. */
var STEP = 5;

/*
 * Runs a command and hands back its output. Gio.Subprocess rather than
 * Cinnamon's spawn helpers, so this module stays loadable outside the shell,
 * and with a timer behind it because ddcutil can hang on a monitor that
 * accepts the connection and then says nothing.
 */
function runCommand(argv, onDone) {
    let done = false;
    let process;

    function finish(output, status) {
        if (done)
            return;
        done = true;
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

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALL_TIMEOUT_MS, () => {
        if (!done) {
            Log.error("ddcutil did not answer in time, giving up on it");
            try {
                process.force_exit();
            } catch (e) {
                /* already gone */
            }
            finish("", -1);
        }
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

/* "Display 1" ... "Display 2" - the numbers ddcutil wants for --display. */
function parseDisplays(output) {
    let displays = [];
    let pattern = /^Display\s+(\d+)\s*$/gm;
    let match;
    while ((match = pattern.exec(output)) !== null)
        displays.push(match[1]);
    return displays;
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
 * The monitors on this machine, as one control.
 *
 * One slider moves all of them, which is what somebody with two monitors on
 * one desk means by "turn the brightness down". The value shown is the first
 * display's, since they are moved together.
 */
var DdcBacklight = class DdcBacklight {
    constructor(onChanged, onReady, run) {
        this.available = false;
        this.percentage = null;
        this.destroyed = false;
        this.displays = [];

        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._run = run || runCommand;
        this._busy = false;
        this._started = false;
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

    _detect() {
        this._run(["ddcutil", "--brief", "detect"], (output, status) => {
            if (this.destroyed)
                return;
            if (status !== 0) {
                /* No ddcutil, no permission, or no display answered. */
                this._onReady();
                return;
            }
            this.displays = parseDisplays(output);
            if (this.displays.length === 0) {
                this._onReady();
                return;
            }
            this.refresh(() => this._onReady());
        });
    }

    /*
     * Reading is skipped while a write is in flight. The value being asked
     * for is about to be overwritten by the write anyway, and asking a
     * monitor two things at once over a bus it answers in tenths of a second
     * is how ddcutil comes back with nothing.
     */
    refresh(onDone) {
        let done = onDone || function () {};
        if (this.displays.length === 0 || this._busy) {
            done();
            return;
        }
        this._run(["ddcutil", "--brief", "--display", this.displays[0],
                   "getvcp", BRIGHTNESS_FEATURE], (output, status) => {
            if (this.destroyed)
                return;
            let value = status === 0 ? parseBrightness(output) : null;
            this.available = value !== null;
            this.percentage = value;
            done();
        });
    }

    /*
     * Writes to every display, and refuses to start a second write while one
     * is in flight: a slider drag would otherwise queue a process per value
     * the pointer passes through, against hardware that answers in tenths of
     * a second.
     */
    setPercentage(value, onDone) {
        if (this.displays.length === 0 || this._busy) {
            if (onDone)
                onDone();
            return;
        }

        let wanted = Math.max(0, Math.min(100, Math.round(value)));
        this._busy = true;
        let pending = this.displays.length;

        let finished = () => {
            if (--pending > 0)
                return;
            this._busy = false;
            if (this.destroyed)
                return;
            this.percentage = wanted;
            if (onDone)
                onDone();
        };

        for (let display of this.displays) {
            this._run(["ddcutil", "--display", display,
                       "setvcp", BRIGHTNESS_FEATURE, String(wanted)], () => finished());
        }
    }

    step(up, onDone) {
        let from = this.percentage === null ? 50 : this.percentage;
        this.setPercentage(from + (up ? STEP : -STEP), onDone);
    }

    destroy() {
        this.destroyed = true;
        this.available = false;
        this.displays = [];
    }
};
