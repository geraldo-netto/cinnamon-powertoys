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

        this._run = run;
        this._busy = false;
    }

    /*
     * Reading is skipped while a write is in flight. The value being asked
     * for is about to be overwritten by the write anyway, and asking a
     * monitor two things at once over a bus it answers in tenths of a second
     * is how ddcutil comes back with nothing.
     */
    refresh(onDone) {
        let done = onDone || function () {};
        if (this.destroyed || this._busy) {
            done();
            return;
        }
        this._run(["ddcutil", "--brief", "--display", this.number,
                   "getvcp", BRIGHTNESS_FEATURE], (output, status) => {
            if (this.destroyed) {
                done();
                return;
            }
            let value = status === 0 ? parseBrightness(output) : null;
            this.available = value !== null;
            this.percentage = value;
            done();
        });
    }

    /*
     * Refuses to start a second write while one is in flight: a slider drag
     * would otherwise queue a process per value the pointer passes through,
     * against hardware that answers in tenths of a second.
     */
    setPercentage(value, onDone) {
        let done = onDone || function () {};
        if (this.destroyed || this._busy) {
            done();
            return;
        }

        let wanted = Math.max(0, Math.min(100, Math.round(value)));
        this._busy = true;
        this._run(["ddcutil", "--display", this.number,
                   "setvcp", BRIGHTNESS_FEATURE, String(wanted)], () => {
            this._busy = false;
            if (this.destroyed) {
                done();
                return;
            }
            this.percentage = wanted;
            done();
        });
    }

    step(up, onDone) {
        let from = this.percentage === null ? 50 : this.percentage;
        this.setPercentage(from + (up ? STEP : -STEP), onDone);
    }

    destroy() {
        this.destroyed = true;
        this.available = false;
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
    constructor(onChanged, onReady, run) {
        this.available = false;
        this.percentage = null;
        this.destroyed = false;
        this.monitors = [];
        /* How many were found beyond MAX_DISPLAYS, so the menu can say so. */
        this.hidden = 0;

        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._run = run || runCommand;
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

            let found = nameDisplays(parseDisplays(output));
            this.hidden = Math.max(0, found.length - MAX_DISPLAYS);
            if (this.hidden > 0)
                Log.error("more than " + MAX_DISPLAYS + " monitors answered DDC/CI; " +
                          this.hidden + " of them have no slider");

            this.monitors = found.slice(0, MAX_DISPLAYS)
                .map(display => new DdcMonitor(display, this._run));
            if (this.monitors.length === 0) {
                this._onReady();
                return;
            }
            this.refresh(() => this._onReady());
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

    setPercentage(value, onDone) {
        let done = onDone || function () {};
        let pending = this.monitors.length;
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

        for (let monitor of this.monitors)
            monitor.setPercentage(value, settle);
    }

    step(up, onDone) {
        let from = this.percentage === null ? 50 : this.percentage;
        this.setPercentage(from + (up ? STEP : -STEP), onDone);
    }

    destroy() {
        this.destroyed = true;
        this.available = false;
        for (let monitor of this.monitors)
            monitor.destroy();
        this.monitors = [];
    }
};
