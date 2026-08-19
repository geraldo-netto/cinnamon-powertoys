/*
 * cinnamon-powertoys - one reading of the machine as the rows of a sensor list.
 *
 * Which readings are worth a row, what each one is called under a heading that
 * already names the chip, where the headings fall, and what the processor's own
 * two rows attach to. None of it needs a menu: rows go in, entries come out,
 * and the widget that draws them sets three strings per row and nothing else.
 *
 * They were methods on the menu presenter in applet.js, which imports the
 * shell's own modules at the top and so cannot be loaded by anything but
 * Cinnamon - the same reason lib/reading.js and lib/alerts.js were moved out
 * before them. The branches that only exist for hardware most machines are not
 * were the point: a chip with a name and no readable temperature, two graphics
 * cards, a processor that reports no temperature at all. Out here they can be
 * asked about.
 */

const Format = require("./lib/format.js");
const Sensors = require("./lib/sensors.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/* How close to the chip's own limit a temperature is flagged at. */
const WARN_WITHIN = 5;

/*
 * What the batteries contribute to the sensor lists.
 *
 * A battery is a sensor as much as a hwmon chip is: it reports its own
 * temperature, and the rate it is charging or draining at is a power meter.
 * So its readings carry everything a hwmon reading carries, including the
 * grouping - one group per device, headed by the device's own name, with the
 * rows under it saying only what they measure. That is the same shape
 * lib/sensors.js produces, and it has to be: the menu concatenates the two
 * lists and groups the result without knowing which came from where.
 *
 * A plain function of a device list, so the shape can be checked without a
 * system bus. It lived in lib/upower.js, whose job is the bus and not the
 * menu; the row vocabulary it speaks - label, group, groupLabel, shortLabel,
 * kind - is the one every other function in this file speaks.
 */
function batteryReadings(devices) {
    let temperatures = [];
    let powers = [];

    for (let device of devices) {
        let title = Format.deviceTitle(device);
        let group = "upower:" + device.path;

        /*
         * Zero degrees is dropped, and it is a reading.
         *
         * It has to be, because UPower cannot say the other thing. Temperature
         * is a plain `d` on the interface with no "is present" beside it, and
         * a device with no thermometer in it publishes 0.0 rather than
         * declining to answer - a bluetooth headset does exactly that. Letting
         * 0 through put "Temperature 0.0 °C" under a heading with the
         * headset's name on it, on a machine where nothing was measuring
         * anything. A battery that really is at freezing loses its row; a
         * dozen devices that measure nothing would otherwise gain one.
         */
        if (device.temperature)
            temperatures.push({
                id: "upower:" + device.path,
                measure: "temperature",
                chip: title,
                kind: "battery",
                label: title,
                group: group,
                groupLabel: title,
                shortLabel: Format.measureName("temperature"),
                critical: null,
                celsius: device.temperature,
            });

        /* Zero watts is not: a battery at rest reports it, and a row saying
         * the machine is drawing nothing at all is worse than no row. */
        if (device.powerSupply && device.energyRate)
            powers.push({
                id: "upower:" + device.path,
                measure: "power",
                kind: "battery",
                label: title,
                group: group,
                groupLabel: title,
                shortLabel: Format.measureName("power"),
                watts: device.energyRate,
            });
    }

    return { temperatures: temperatures, powers: powers };
}

/*
 * A menu key unique across the three lists. Ids are unique within one of
 * them but not between them: a battery that reports both a temperature
 * and a draw carries the same UPower path in each, and what tells the two
 * readings apart is what they measure.
 */
function entryKey(reading) {
    return reading.measure + ":" + reading.id;
}

/*
 * A reading as a row.
 *
 * The label is the short one - "Edge", not "amdgpu edge (03:00.0)" -
 * because the heading above the row already says which chip it came off.
 * The long name is kept as a fallback for anything that arrived without a
 * group, and for a machine whose libraries predate the short one.
 */
function rowLabel(reading) {
    return reading.shortLabel || reading.label;
}

/* A temperature is worth flagging as it closes on the chip's own limit. */
function temperatureEntry(sensor, options) {
    return {
        key: entryKey(sensor),
        kind: sensor.kind,
        group: sensor.group,
        groupLabel: sensor.groupLabel,
        measure: sensor.measure,
        label: rowLabel(sensor),
        value: Format.temperature(sensor.celsius, options.tempUnit, 1),
        warning: sensor.critical !== null && sensor.celsius >= sensor.critical - WARN_WITHIN,
    };
}

function fanEntry(fan) {
    return { key: entryKey(fan), kind: fan.kind, measure: fan.measure,
             group: fan.group, groupLabel: fan.groupLabel,
             label: rowLabel(fan), value: Format.rpm(fan.rpm), warning: false };
}

function powerEntry(meter) {
    return { key: entryKey(meter), kind: meter.kind, measure: meter.measure,
             group: meter.group, groupLabel: meter.groupLabel,
             label: rowLabel(meter), value: Format.watts(meter.watts),
             warning: false };
}

/*
 * One kind of reading turned into menu entries: drop what cannot be read,
 * drop the uninteresting kinds unless the menu was asked for all of them.
 */
function entriesOf(readings, showAll, isReadable, toEntry) {
    let usable = readings.filter(isReadable);
    if (!showAll)
        usable = usable.filter(reading => Sensors.isPrimaryKind(reading.kind));
    return usable.map(toEntry);
}

/*
 * A heading wherever the chip changes.
 *
 * With every sensor shown this list is nineteen rows on the machine it was
 * written on, and nineteen undifferentiated rows is a wall. Headed groups
 * of two to seven are a list.
 *
 * The heading used to be the kind - "Processor", "Graphics" - which was a
 * wall of its own on a machine with two graphics cards: one heading over
 * seven rows, of which two belonged to a different card and said so only
 * in a PCI address at the end of each row. It is the chip itself now, by
 * name, so the address is gone from the rows and the two cards are two
 * blocks.
 */
function withHeadings(entries, leadIn) {
    let out = [];
    let group = null;
    let placed = !leadIn || leadIn.rows.length === 0;

    for (let entry of entries) {
        if (entry.group !== group) {
            group = entry.group;
            out.push({ key: "heading:" + group, heading: true,
                       label: entry.groupLabel || Sensors.kindLabel(entry.kind) });
            if (!placed && group === leadIn.group) {
                for (let row of leadIn.rows)
                    out.push(row);
                placed = true;
            }
        }
        out.push(entry);
    }

    /* The chip the lead-in belongs to reported nothing readable, so it has
     * no group of its own here. It still has a name and the rows still say
     * something, so they get a heading of their own at the front. */
    if (!placed) {
        out = [{ key: "heading:" + leadIn.group, heading: true, label: leadIn.groupLabel }]
            .concat(leadIn.rows, out);
    }
    return out;
}

/*
 * What the processor says about itself, filed with the readings off the
 * same chip.
 *
 * The frequency and the scaling driver were rows in the Processor group,
 * where they sat above the governor and the boost switch as though they
 * were settings. They are not: they are what the chip is doing and what is
 * doing it, which is the same kind of thing as its temperature. So they go
 * under the chip's own name, ahead of its temperatures, and the Processor
 * group is left holding only what can be changed.
 *
 * They attach to whichever sensor group came off the processor. Where the
 * machine reports no processor temperature at all there is no such group,
 * and the name from /proc/cpuinfo heads one for them.
 */
function cpuReadingRows(data) {
    if (!data.cpu.available)
        return null;

    let host = data.temperatures.find(sensor => sensor.kind === "cpu" && sensor.group);
    let rows = [];

    /* What it is running at, and what it was built to reach. Either can be
     * missing on its own - the current frequency is a node per policy and a
     * kernel can decline to publish it, the ceiling is one node that is not
     * always there - and the pair used to be joined before it was known there
     * were two, so a machine that could read only the ceiling drew a row
     * reading " / 4.30 GHz". */
    let frequencies = [Format.frequency(data.cpu.averageFrequency),
                       Format.frequency(data.cpu.maxFrequency)].filter(text => text !== "");
    if (frequencies.length > 0)
        rows.push({ key: "cpu:frequency", label: _("Frequency"),
                    value: frequencies.join(" / "), warning: false });

    let drivers = data.cpu.drivers || (data.cpu.driver ? [data.cpu.driver] : []);
    if (drivers.length > 0) {
        let labels = drivers.map(driver => Format.driverLabel(
            driver, /^amd[-_]pstate/.test(driver) ? data.cpu.amdPstateStatus : null));
        rows.push({ key: "cpu:driver",
                    label: drivers.length > 1 ? _("Scaling drivers") : _("Scaling driver"),
                    value: labels.join(" / "), warning: false });
    }

    /*
     * The governor and the energy preference were stated here too, while
     * the daemon owned them. What that put on screen was "Performance"
     * three times in one menu - the filled segment, then twice more under
     * the chip - and the two extra rows read as settings nobody could find
     * the control for, because the control is the profile, two columns to
     * the left, and nothing said so. A reading of a setting is not like a
     * temperature: it invites changing, and these rows could only decline.
     * The tooltip still names the governor in force, beside the profile
     * that wrote it.
     */

    return {
        group: host ? host.group : "cpu:processor",
        groupLabel: host ? host.groupLabel : (data.cpu.model || Sensors.kindLabel("cpu")),
        rows: rows,
    };
}

/*
 * The whole list, headings and all, from one reading.
 *
 * A machine that reports nothing readable gets one row saying so rather than
 * an empty group, because an empty group and a broken one look the same.
 * `options` is the menu's own: which unit temperatures are shown in, and
 * whether every kind of sensor was asked for.
 */
function rows(data, options) {
    let all = options.showAllSensors;
    let entries = [].concat(
        entriesOf(data.temperatures, all, sensor => sensor.celsius !== null,
                  sensor => temperatureEntry(sensor, options)),
        entriesOf(data.fans, all, fan => fan.rpm !== null && (fan.rpm > 0 || fan.inUse),
                  fan => fanEntry(fan)),
        entriesOf(data.powers, all, () => true,
                  meter => powerEntry(meter)));

    let leadIn = cpuReadingRows(data);

    if (entries.length === 0 && (!leadIn || leadIn.rows.length === 0)) {
        if (!all)
            return [{ key: "empty", label: _("No primary sensors found"),
                      value: _("Enable disk, network and board sensors in settings"),
                      warning: false }];
        return [{ key: "empty", label: _("No sensors found"), value: "", warning: false }];
    }

    entries.sort(Sensors.bySensorOrder);
    return withHeadings(entries, leadIn);
}
