/*
 * The powercap counters, and turning them into watts.
 *
 * /sys/class/powercap is not hwmon. It publishes energy in microjoules on a
 * monotonic 32-bit register that wraps, and the watts anybody wants out of it
 * are the difference between two readings divided by the time between them -
 * arithmetic with a wrap to survive, which is nothing to do with reading a
 * labelled node off a chip. A few platforms publish a power_uw directly and
 * those are read as they are.
 *
 * It also has names of its own: the kernel says "package-0", "core", "uncore",
 * "dram" and "psys", and a machine with one socket has nothing to tell apart.
 *
 * All of it lived in lib/sensors.js beside the hwmon sweep, sharing nothing
 * with it but a directory listing.
 */

const GLib = imports.gi.GLib;

const Format = require("./lib/format.js");
const IO = require("./lib/io.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const POWERCAP_DIR = "/sys/class/powercap";

/*
 * A RAPL domain directory is named intel-rapl:0 for a whole package and
 * intel-rapl:0:1 for one of its parts, so the top level ones are exactly the
 * domains that can be added up without counting the same joules twice.
 */
const RAPL_PACKAGE_DOMAIN = /^(intel|amd)-rapl:\d+$/;

/*
 * What powercap calls a domain, said in words.
 *
 * The kernel's names are "package-0" for a socket and, inside it, "core" for
 * the cores, "uncore" for the graphics and the rest of the die, "dram" for
 * the memory and "psys" for the whole board where the firmware measures that.
 * A machine with one socket has nothing to tell apart, so its package is just
 * the package; where there are several, each keeps its number.
 */
const RAPL_NAMES = [
    [/^core$/i, () => _("Cores")],
    [/^uncore$/i, () => _("Uncore")],
    [/^dram$/i, () => _("Memory")],
    [/^psys$/i, () => _("Whole board")],
];

function raplName(raw, packages) {
    let match = /^package-(\d+)$/i.exec(raw);
    if (match)
        return packages > 1 ? Translate.interpolate(
            _("Package %{number}"), { number: match[1] }) : _("Package");
    for (let [pattern, name] of RAPL_NAMES) {
        if (pattern.test(raw))
            return name();
    }
    return raw;
}

/*
 * RAPL / powercap energy counters. Since CVE-2020-8694 energy_uj is usually
 * 0400, so this returns an empty list on most systems - that is expected and
 * simply means no package power readout. README says how to hand it back, and
 * what is being handed back with it.
 */
function energyCounters(entries, readString, canRead) {
    let found = [];
    let readable = canRead || (path => readString(path) !== null);
    let readNumber = path => IO.toNumber(readString(path));
    for (let entry of entries) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let energyPath = base + "/energy_uj";
        /* DTPM's native interface is an instantaneous power value. Prefer it
         * when present rather than exposing the same domain twice. */
        if (entry.startsWith("dtpm") && readable(base + "/power_uw"))
            continue;
        if (!readable(energyPath))
            continue;
        found.push({
            entry: entry,
            base: base,
            energyPath: energyPath,
            raw: readString(base + "/name") || entry,
        });
    }

    /* Counted before anything is named, because whether one package needs its
     * number said depends on how many there are. */
    let packages = found.filter(item => /^package-\d+$/i.test(item.raw)).length;

    return found.map(item => ({
        id: "rapl:" + item.entry,
        measure: "power",
        kind: "package",
        /* Not a chip, so it has no chip's name to be grouped under; the
         * kind is what these have in common and all they have. */
        group: "rapl",
        label: raplName(item.raw, packages),
        path: item.energyPath,
        maxRange: readNumber(item.base + "/max_energy_range_uj"),
        domain: item.entry,
        topLevel: RAPL_PACKAGE_DOMAIN.test(item.entry),
    }));
}

/* DTPM domains expose instantaneous microwatts rather than an energy counter.
 * Only a root domain is a platform aggregate; its children remain individual
 * rows and are never added to it. */
function directPowercapSensors(entries, readString, canRead) {
    let found = [];
    let readable = canRead || (path => readString(path) !== null);
    for (let entry of entries) {
        if (!/^dtpm(?::\d+)+$/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        let path = base + "/power_uw";
        if (!readable(path))
            continue;
        let topLevel = /^dtpm:\d+$/.test(entry);
        let raw = readString(base + "/name") || entry;
        let label = topLevel ? _("Total") : Format.capitalize(raw);
        found.push({
            id: "dtpm-power:" + entry,
            measure: "power",
            source: "powercap",
            kind: topLevel ? "package" : "other",
            group: "dtpm",
            groupLabel: "DTPM",
            rawLabel: raw,
            label: label,
            display: label,
            short: label,
            path: path,
            platformTotal: topLevel,
        });
    }
    return found;
}

function discoverDirectPowercapSensors() {
    return directPowercapSensors(IO.listDir(POWERCAP_DIR), IO.readString, IO.canRead);
}

function discoverEnergyCounters() {
    return energyCounters(IO.listDir(POWERCAP_DIR), IO.readString, IO.canRead);
}

function powercapTopology(entries, readable) {
    return entries.map(entry => {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            return entry;
        let base = POWERCAP_DIR + "/" + entry;
        let interfaces = [];
        if (readable(base + "/energy_uj"))
            interfaces.push("energy");
        if (readable(base + "/power_uw"))
            interfaces.push("power");
        return entry + ":" + (interfaces.join("+") || "restricted");
    }).join(",");
}

function powercapAccessPaths(entries) {
    let paths = [];
    for (let entry of entries) {
        if (!/^(intel-rapl|amd-rapl|dtpm)/.test(entry))
            continue;
        let base = POWERCAP_DIR + "/" + entry;
        paths.push(base + "/energy_uj", base + "/power_uw");
    }
    return paths;
}

/* Turns a monotonic microjoule counter into watts. */
const EnergyMeter = class EnergyMeter {
    constructor(counter) {
        this.counter = counter;
        this.id = counter.id;
        this.measure = counter.measure;
        this.kind = counter.kind;
        this.label = counter.label;
        this.group = counter.group;
        this.domain = counter.domain;
        /* whether this counter may be added into a whole-package total */
        this.topLevel = counter.topLevel;
        this.watts = null;
        this._lastValue = null;
        this._lastTime = 0;
    }

    /*
     * Advances the counter, and answers nothing.
     *
     * What it produced is `watts`, which is null until two readings far
     * enough apart have been taken. It used to return that value and, when
     * the pair was unusable, quietly return the one before it - so a caller
     * could not tell a fresh reading from a stale one. Now an unusable pair
     * says so.
     *
     * `now` is the monotonic clock in microseconds, and is a parameter only
     * so the arithmetic can be exercised without waiting for real time to
     * pass. `readNumber` is where the counter is read from, which is how the
     * same meter works against a value already loaded off the main loop.
     */
    sample(now, readNumber) {
        let read = readNumber || IO.readNumber;
        let value = read(this.counter.path);
        let taken = now === undefined ? GLib.get_monotonic_time() : now;

        if (value === null) {
            this.watts = null;
            this._lastValue = null;
            return;
        }

        if (this._lastValue === null) {
            /* First reading: nothing to subtract from. */
            this.watts = null;
        } else {
            let energy = value - this._lastValue;
            if (energy < 0) {
                /* A falling counter may have wrapped, or somebody may have
                 * reset energy_uj to zero through the powercap ABI. Only
                 * values on opposite edges of the range are evidence of a
                 * wrap; every ambiguous fall is discarded and rebaselined. */
                let range = this.counter.maxRange;
                let wrapped = range && value > 0 &&
                    this._lastValue >= range * 0.75 && value <= range * 0.25;
                energy = wrapped ? energy + range : -1;
            }
            let elapsed = taken - this._lastTime;
            /* microjoules per microsecond is watts */
            this.watts = (elapsed > 0 && energy >= 0) ? energy / elapsed : null;
        }

        this._lastValue = value;
        this._lastTime = taken;
    }
};

