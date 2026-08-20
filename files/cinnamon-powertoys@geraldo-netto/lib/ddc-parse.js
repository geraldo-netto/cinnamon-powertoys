/*
 * What ddcutil said, as something the rest of this can use.
 *
 * Text in, structure out. No process, no Gio, no timer and no state: a
 * detection listing becomes displays with names, a VCP line becomes a
 * percentage, and two EDID identities become an answer about whether they are
 * the same screen.
 *
 * It was the front of lib/ddc.js, in front of a process runner, a per-monitor
 * object, a command queue and the facade the applet talks to - so the one part
 * of that file with nothing asynchronous in it could only be reached past four
 * things that are.
 */

const Hardware = require("./lib/hardware.js");
const Naming = require("./lib/naming.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

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

        let separator = line.indexOf(":");
        if (separator < 0)
            continue;
        let field = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (field === "I2C bus")
            current.bus = value;
        else if (field === "DRM connector")
            current.connector = value;
        else if (field === "Monitor") {
            let parts = value.split(":");
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
    let names = Naming.disambiguate(displays, {
        name: display =>
            Hardware.monitorName(display.manufacturer, display.model) ||
            _connectorName(display.connector) ||
            Translate.interpolate(_("Display %{number}"), { number: display.number }),
        identity: display => _connectorName(display.connector) || display.number,
    });
    return displays.map((display, index) => ({ ...display, name: names[index] }));
}

/*
 * "VCP 10 C 40 100" - feature, type, current, maximum. The maximum is not
 * always 100, so the percentage has to be worked out rather than assumed.
 */
function parseBrightnessReading(output) {
    let match = /^VCP\s+10\s+\S+\s+(\d+)\s+(\d+)/m.exec(output || "");
    if (!match)
        return null;
    let current = Number(match[1]);
    let maximum = Number(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0)
        return null;
    /* A monitor that reports a current above its own maximum - which is a
     * monitor whose firmware counts the two in different units, and there are
     * some - would otherwise put a slider past its end and a figure that is
     * not a percentage of anything on screen. */
    return {
        percentage: Math.min(100, Math.round(current / maximum * 100)),
        maximum: maximum,
    };
}

function parseBrightness(output) {
    let reading = parseBrightnessReading(output);
    return reading ? reading.percentage : null;
}

/* EDID identity stays private: a serial belongs in a comparison, not in a
 * menu or a screenshot. Missing fields are unknown rather than different,
 * because a marginal DDC reply can omit one field for the same monitor. */
function displayIdentity(display) {
    let clean = value => String(value || "").trim().toLowerCase();
    return {
        manufacturer: clean(display.manufacturer),
        model: clean(display.model),
        serial: clean(display.serial),
    };
}

function sameDisplay(first, second) {
    for (let field of ["manufacturer", "model", "serial"])
        if (first[field] && second[field] && first[field] !== second[field])
            return false;
    return true;
}

