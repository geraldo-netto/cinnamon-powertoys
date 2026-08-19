/*
 * One reading of the whole machine, in two halves: taking it, and making it.
 *
 * Every backend describes its own part. What is left over is putting the parts
 * side by side, waiting for the slow ones, and answering the two questions that
 * need more than one of them - which sensor the panel shows, and which of
 * several numbers counts as the machine's power draw.
 *
 * Both halves were methods on the applet, which imports the shell and cannot be
 * loaded outside Cinnamon. The waiting in particular was four booleans and a
 * function that re-read all four: correct, and impossible to try a fifth part
 * against, or to ask what happens when one part settles twice.
 */

const Device = require("./lib/device.js");
const Once = require("./lib/once.js");
const Reading = require("./lib/reading.js");
const SensorRows = require("./lib/sensor-rows.js");
const Sensors = require("./lib/sensors.js");

/*
 * Several answers, and the one moment they are all in.
 *
 * `parts` is a list of functions, each handed a `done` to call when its own
 * answer has arrived; `onDone` is called once, after the last of them. A part
 * that answers before it returns - a backend that has nothing to sample, a
 * failure raised on the way in - is as ordinary as one that answers on the bus
 * an hour later, so the count is only complete once every part has been
 * started, and the last one to finish is the one that settles it.
 *
 * A part settling twice is a bug in that part, and it must not make a reading
 * be published twice; lib/once.js holds each `done` to one arrival.
 */
function gather(parts, onDone) {
    let settle = Once.once(onDone || function () {});
    let list = parts || [];
    /* One more than the parts, held until every part has been started. Without
     * it, a list whose first part answers immediately settles the whole
     * gathering before the second has been asked. */
    let outstanding = list.length + 1;
    let arrive = () => {
        outstanding--;
        if (outstanding === 0)
            settle();
    };
    for (let part of list)
        part(Once.once(arrive));
    arrive();
    return settle;
}

/*
 * The sensor readings, and everything else that describes the machine, put
 * side by side.
 *
 * `sources` carries what was read: `readings` from the sensor sweep, `upower`
 * from lib/upower.js's own read, `bluetooth` the BlueZ client (asked for
 * `available` and `missingFrom` only), `cpu` the processor snapshot, `charge`
 * the charge-limit answer, `profile` the profile snapshot, and `sensorHint`
 * whatever the user typed into the primary-sensor box.
 */
function assemble(sources) {
    let readings = sources.readings;
    let upower = sources.upower;
    let bluetooth = sources.bluetooth;
    let charge = sources.charge;

    /* Anything with a charge that UPower did not mention. */
    let devices = upower.devices.concat(bluetooth.missingFrom(upower.devices));
    devices = Device.withPrimary(devices, upower.primary);

    /* The batteries are sensors too, and what they contribute to the two lists
     * is a function of the devices UPower reported. */
    let battery = SensorRows.batteryReadings(upower.devices);
    let temperatures = readings.temperatures.concat(battery.temperatures);
    let powers = readings.powers.concat(battery.powers);
    let power = Reading.pickPower(upower.primary, readings.packageWatts, powers);
    let picked = Reading.pickTemperature(temperatures, sources.sensorHint,
                                         Sensors.sensorMatches);

    return {
        upowerAvailable: upower.available,
        bluezAvailable: bluetooth.available,
        devices: devices,
        lines: upower.lines,
        primary: upower.primary,
        onBattery: upower.onBattery,
        temperatures: temperatures,
        fans: readings.fans,
        powers: powers,
        packageWatts: readings.packageWatts,
        cpu: sources.cpu,
        profile: sources.profile,
        /* whether this machine has a battery whose limit can be written */
        chargeLimitAvailable: charge.available,
        chargeLimit: charge.limit,
        chargeLimitState: charge.state,
        /* The picker can deliberately choose a GPU, battery or explicitly
         * hinted sensor. Keep its identity beside the value so an alert and the
         * tooltip can say what they are reporting. */
        selectedTemperature: picked.sensor,
        /* whether the user's hint is the reason it came from there - false
         * means they asked for a sensor and it was not found, which is worth
         * saying out loud */
        hintMatched: picked.hintMatched,
        systemWatts: power.watts,
        systemWattsSource: power.source,
    };
}
