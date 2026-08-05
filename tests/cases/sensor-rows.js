/*
 * One reading of the machine as the rows of a sensor list.
 *
 * These were methods on the menu presenter in applet.js, which no case can
 * load, so what could be checked about them was nothing at all - and what they
 * decide is most of what the largest column in this menu says: which readings
 * are worth a row, what each row is called, where the headings fall, and where
 * the processor's own two rows attach.
 *
 * The cases that matter are the ones about hardware the machine this was
 * written on is not: two graphics cards, a chip whose temperature cannot be
 * read, a processor that reports no temperature at all.
 */

const Harness = imports.harness;

const SensorRows = Harness.requireXlet("./lib/sensor-rows.js");

/* A reading, with only the parts these functions look at. */
function reading(parts) {
    return Object.assign({
        temperatures: [],
        fans: [],
        powers: [],
        cpu: { available: false, averageFrequency: null, maxFrequency: null,
               driver: null, amdPstateStatus: null, model: null },
    }, parts || {});
}

function temperature(parts) {
    return Object.assign({
        id: "hwmon:hwmon0:temp1", measure: "temperature", kind: "cpu",
        group: "hwmon:hwmon0", groupLabel: "Ryzen 5 5600", label: "k10temp Tctl",
        shortLabel: "Cooling control (Tctl)", critical: 95, celsius: 44.5,
    }, parts || {});
}

function fan(parts) {
    return Object.assign({
        id: "hwmon:hwmon2:fan1", measure: "fan", kind: "board",
        group: "hwmon:hwmon2", groupLabel: "nct6798", label: "nct6798 fan1",
        shortLabel: "Fan 1", rpm: 900,
    }, parts || {});
}

function meter(parts) {
    return Object.assign({
        id: "rapl:intel-rapl:0", measure: "power", kind: "package",
        group: "rapl", groupLabel: "Package", label: "Package",
        shortLabel: "Package", watts: 24.4,
    }, parts || {});
}

/* The two options these read. */
function options(parts) {
    return Object.assign({ tempUnit: "celsius", showAllSensors: false }, parts || {});
}

function labels(entries) {
    return entries.map(entry => (entry.heading ? "== " : "") + entry.label);
}

var cases = {};

cases["a machine that reports nothing readable says so"] = function () {
    /* An empty group and a broken one look the same, and a desktop whose
     * sensors are all behind a driver that is not loaded is the first. */
    let entries = SensorRows.rows(reading(), options());
    Harness.equal(entries.length, 1, "one row");
    Harness.equal(entries[0].key, "empty", "the one that says there is nothing");
    Harness.equal(entries[0].label, "No primary sensors found", "the filtered claim");
    Harness.ok(entries[0].value.indexOf("disk, network and board") >= 0,
               "and where the other sensors can be enabled");
};

cases["a reading that cannot be read is not a row"] = function () {
    /*
     * amdgpu answers EBUSY while the card is asleep, a fan that is stopped
     * reports zero, and a row saying nothing at all is worse than no row. The
     * power meters are the exception: a meter that could not be sampled is
     * already absent from the list rather than present and null.
     */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ celsius: null })],
        fans: [fan({ rpm: 0 }), fan({ id: "fan2", rpm: null })],
    }), options({ showAllSensors: true }));

    Harness.equal(entries.length, 1, "nothing was readable");
    Harness.equal(entries[0].key, "empty", "so the list says so");
    Harness.equal(entries[0].label, "No sensors found", "all kinds were considered");
};

cases["a known fan remains visible while stopped"] = function () {
    let entries = SensorRows.rows(reading({
        fans: [fan({ rpm: 0, inUse: true, rawLabel: "CPU Fan" })],
    }), options({ showAllSensors: true }));

    Harness.deepEqual(labels(entries), ["== nct6798", "Fan 1"],
                      "zero RPM is a real reading for a known input");
    Harness.equal(entries[1].value, "0 RPM", "the stopped value is shown");
};

cases["only the interesting kinds, unless every one was asked for"] = function () {
    /*
     * Reading a disk temperature wakes the drive, so the menu hides those by
     * default - and the switch that shows them is the only thing between a
     * five row list and a nineteen row one.
     */
    let data = reading({
        temperatures: [temperature(),
                       temperature({ id: "nvme", kind: "disk", group: "hwmon:hwmon1",
                                     groupLabel: "Samsung 980", shortLabel: "Composite" })],
    });

    Harness.deepEqual(labels(SensorRows.rows(data, options())),
                      ["== Ryzen 5 5600", "Cooling control (Tctl)"],
                      "the processor, and not the disk");
    Harness.deepEqual(labels(SensorRows.rows(data, options({ showAllSensors: true }))),
                      ["== Ryzen 5 5600", "Cooling control (Tctl)",
                       "== Samsung 980", "Composite"],
                      "and both where the menu was asked for all of them");
};

cases["a heading wherever the chip changes"] = function () {
    /*
     * Two graphics cards are two blocks rather than one interleaved list. That
     * is the whole reason the heading is the chip and not the kind: a heading
     * reading "Graphics" over seven rows, two of which belong to the other
     * card, tells nobody which card is at 81 degrees.
     */
    let entries = SensorRows.rows(reading({
        temperatures: [
            temperature({ id: "gpu1", kind: "gpu", group: "hwmon:hwmon4",
                          groupLabel: "Radeon RX 6600", shortLabel: "Die edge" }),
            temperature({ id: "gpu1j", kind: "gpu", group: "hwmon:hwmon4",
                          groupLabel: "Radeon RX 6600", shortLabel: "Hotspot" }),
            temperature({ id: "gpu2", kind: "gpu", group: "hwmon:hwmon5",
                          groupLabel: "Radeon 780M", shortLabel: "Die edge" }),
        ],
    }), options({ showAllSensors: true }));

    Harness.deepEqual(labels(entries),
                      ["== Radeon RX 6600", "Die edge", "Hotspot",
                       "== Radeon 780M", "Die edge"],
                      "one heading per card, and the rows under their own");
    Harness.equal(entries[0].key, "heading:hwmon:hwmon4", "keyed by the group it heads");
};

cases["a chip that never said what it is called is headed by its kind"] = function () {
    /* groupLabel is composed at discovery and a reading that arrived without
     * one still has to be filed somewhere. */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ groupLabel: "" })],
    }), options());
    Harness.equal(entries[0].heading, true, "still a heading");
    Harness.equal(entries[0].label, "Processor", "named after what kind of thing it is");
};

cases["a temperature closing on the chip's own limit is flagged"] = function () {
    let hot = SensorRows.rows(reading({
        temperatures: [temperature({ celsius: 91, critical: 95 })],
    }), options());
    Harness.equal(hot[1].warning, true, "within five degrees of critical");

    let warm = SensorRows.rows(reading({
        temperatures: [temperature({ celsius: 89.9, critical: 95 })],
    }), options());
    Harness.equal(warm[1].warning, false, "and not before that");

    /* Most drivers publish no limit at all, and a reading with nothing to be
     * measured against is never a warning. */
    let unlimited = SensorRows.rows(reading({
        temperatures: [temperature({ celsius: 120, critical: null })],
    }), options());
    Harness.equal(unlimited[1].warning, false, "nothing to compare it to");
};

cases["a temperature is shown in the unit the menu was asked for"] = function () {
    let celsius = SensorRows.rows(reading({ temperatures: [temperature({ celsius: 44.5 })] }),
                                  options());
    Harness.equal(celsius[1].value, "44.5 °C", "as it was read");

    let fahrenheit = SensorRows.rows(reading({ temperatures: [temperature({ celsius: 44.5 })] }),
                                     options({ tempUnit: "fahrenheit" }));
    Harness.equal(fahrenheit[1].value, "112.1 °F", "and converted where that was asked for");
};

cases["two readings off one chip are told apart by what they measure"] = function () {
    /*
     * Ids are unique within a list and not between them: a battery that
     * reports both a temperature and a draw carries the same UPower path in
     * each. Two entries with one key would leave the second row never updated.
     */
    let path = "upower:/org/freedesktop/UPower/devices/battery_BAT0";
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ id: path, kind: "battery", group: "upower:bat",
                                     groupLabel: "Sony BAT0", shortLabel: "Temperature" })],
        powers: [meter({ id: path, kind: "battery", group: "upower:bat",
                         groupLabel: "Sony BAT0", shortLabel: "Power" })],
    }), options());

    let keys = entries.filter(entry => !entry.heading).map(entry => entry.key);
    Harness.deepEqual(keys, ["temperature:" + path, "power:" + path],
                      "one key each, and they differ");
};

cases["the processor's own rows are filed under the processor"] = function () {
    /*
     * The frequency and the scaling driver are what the chip is doing, not
     * settings, so they go under the chip's own heading and ahead of its
     * temperatures rather than in the Processor group with the controls.
     */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature()],
        cpu: { available: true, averageFrequency: 3512, maxFrequency: 4650,
               driver: "amd-pstate-epp", amdPstateStatus: "active", model: "Ryzen 5 5600" },
    }), options());

    Harness.deepEqual(labels(entries),
                      ["== Ryzen 5 5600", "Frequency", "Scaling driver",
                       "Cooling control (Tctl)"],
                      "ahead of the readings off the same chip");
    Harness.equal(entries[1].value, "3.51 GHz / 4.65 GHz", "what it is at, and what it reaches");
};

cases["a processor that reports no temperature still gets its heading"] = function () {
    /*
     * There is no sensor group to attach to on a machine whose processor
     * publishes nothing, so the two rows would have had nowhere to go. The
     * name out of /proc/cpuinfo heads one of their own, at the front.
     */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ kind: "gpu", group: "hwmon:hwmon4",
                                     groupLabel: "Radeon RX 6600", shortLabel: "Die edge" })],
        cpu: { available: true, averageFrequency: 2400, maxFrequency: null,
               driver: null, amdPstateStatus: null, model: "Cortex-A76" },
    }), options());

    Harness.deepEqual(labels(entries),
                      ["== Cortex-A76", "Frequency", "== Radeon RX 6600", "Die edge"],
                      "a heading of its own, in front of everything else");
};

cases["a processor with no name at all is still the processor"] = function () {
    /* /proc/cpuinfo answers nothing recognisable on some boards, and a
     * heading is still wanted over the rows. */
    let entries = SensorRows.rows(reading({
        cpu: { available: true, averageFrequency: 1800, maxFrequency: null,
               driver: null, amdPstateStatus: null, model: null },
    }), options());
    Harness.deepEqual(labels(entries), ["== Processor", "Frequency"], "named for what it is");
};

cases["a ceiling that can be read on its own is not half a range"] = function () {
    /*
     * The two halves of the frequency are read from different places - the
     * current one is a node per cpufreq policy, the ceiling is one node - and
     * either can be missing on its own. Joined before it was known there were
     * two, a machine that could read only the ceiling drew " / 4.65 GHz".
     */
    let ceilingOnly = SensorRows.rows(reading({
        cpu: { available: true, averageFrequency: null, maxFrequency: 4650,
               driver: null, amdPstateStatus: null, model: "Ryzen 5 5600" },
    }), options());
    Harness.equal(ceilingOnly[1].value, "4.65 GHz", "the one figure there is");

    let currentOnly = SensorRows.rows(reading({
        cpu: { available: true, averageFrequency: 3512, maxFrequency: null,
               driver: null, amdPstateStatus: null, model: "Ryzen 5 5600" },
    }), options());
    Harness.equal(currentOnly[1].value, "3.51 GHz", "and the other way round");
};

cases["a processor with nothing to say about itself leads nothing in"] = function () {
    /* No cpufreq at all: the rows are not there, so the heading they would
     * have brought with them is not either. */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature()],
        cpu: { available: false, averageFrequency: 3512, maxFrequency: 4650,
               driver: "acpi-cpufreq", amdPstateStatus: null, model: "Ryzen 5 5600" },
    }), options());
    Harness.deepEqual(labels(entries), ["== Ryzen 5 5600", "Cooling control (Tctl)"],
                      "only what the sensors said");
};

cases["a reading with no short name falls back to the long one"] = function () {
    /* Composed at discovery, and anything that arrived without a group never
     * had one composed for it. */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ shortLabel: null, label: "k10temp Tctl" })],
    }), options());
    Harness.equal(entries[1].label, "k10temp Tctl", "the name it does have");
};

cases["the three kinds of reading are in the order they are read in"] = function () {
    /*
     * Temperature, then fan, then power, within one chip - which is the order
     * of interest, and the reason the three lists are sorted together rather
     * than one after another.
     */
    let entries = SensorRows.rows(reading({
        temperatures: [temperature({ kind: "gpu", group: "hwmon:hwmon4",
                                     groupLabel: "Radeon RX 6600", shortLabel: "Die edge" })],
        fans: [fan({ kind: "gpu", group: "hwmon:hwmon4", groupLabel: "Radeon RX 6600",
                     shortLabel: "Fan" })],
        powers: [meter({ kind: "gpu", group: "hwmon:hwmon4", groupLabel: "Radeon RX 6600",
                         shortLabel: "Power" })],
    }), options());

    Harness.deepEqual(labels(entries),
                      ["== Radeon RX 6600", "Die edge", "Fan", "Power"],
                      "one block per chip, in measure order");
    Harness.equal(entries[2].value, "900 RPM", "a fan says how fast");
    Harness.equal(entries[3].value, "24 W", "and a meter says how much");
};
