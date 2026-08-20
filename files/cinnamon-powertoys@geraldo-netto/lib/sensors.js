/*
 * What sensors this machine has, what they read, and noticing when that
 * changes.
 *
 * Three objects: the inventory, which owns one snapshot of the machine and
 * replaces it when the machine moves; the reader, which is a function of that
 * snapshot and a way of getting a value; and the set, which is the two of them
 * together and is what the applet holds.
 *
 * Where a sensor is and what it is called is lib/sensor-scan.js and
 * lib/sensor-kinds.js, and the powercap counters are lib/energy.js. What is
 * here is the lifecycle: one discovery at a time, one reading at a time, and
 * nothing published from a machine that has already been asked about again.
 */

const Energy = require("./lib/energy.js");
const Format = require("./lib/format.js");
const IO = require("./lib/io.js");
const Kinds = require("./lib/sensor-kinds.js");
const Once = require("./lib/once.js");
const Refresh = require("./lib/refresh.js");
const Scan = require("./lib/sensor-scan.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * What sensors this machine has, and noticing when that changes.
 *
 * Discovery is the expensive half - every hwmon directory listed, every label
 * file opened - and it only changes when hardware does, so it happens once
 * and the result is kept. Two independent coalescing rules live here and
 * nowhere else: one discovery at a time with at most one replay behind it,
 * and one topology check at a time with at most one recheck behind it, since
 * a menu opened five times in a second must not put five sweeps of sysfs on
 * the bus.
 *
 * Nothing here reads a sensor value. What the values mean is SensorReader's.
 */
const SensorInventory = class SensorInventory {
    constructor(options) {
        let configuration = options || {};
        this._topology = null;
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        this._asynchronous = !!configuration.asynchronous;
        this._onChanged = configuration.onChanged || function () {};
        this._io = configuration.io || {};
        this._discovering = false;
        this._discoverAgain = false;
        this._discoverWaiters = [];
        this._discoverNextWaiters = [];
        /* One topology check at a time and one replay however many callers
         * asked; lib/refresh.js owns that. It also holds a check requested
         * during the first full discovery, which is what `defer` is for: that
         * discovery establishes the topology the check would compare against,
         * so there is nothing to compare until it lands. */
        this._refresh = new Refresh.Coalescer({
            sweep: done => this._sweep(done),
            defer: () => this._discovering,
        });
        this._destroyed = false;
    }

    start() {
        if (this._asynchronous)
            this.discoverAsync();
        else
            this.discover();
    }

    /* What was discovered, as one thing that can be held on to. */
    lists() {
        return {
            temperatures: this.temperatureSensors,
            fans: this.fanSensors,
            meters: this.energyMeters,
            powers: this.powerSensors,
        };
    }

    discover() {
        if (this._destroyed)
            return;
        let found = Scan.discoverSensors();
        this._adopt(found, Energy.discoverEnergyCounters(), this._topologyKey(),
                    Energy.discoverDirectPowercapSensors());
    }

    /*
     * A complete sweep, adopted when it lands.
     *
     * `inventory` is an optional sweep already in hand: the refresh check has
     * just read every path this needs, so when it finds the machine changed
     * the snapshot is assembled from what it read rather than from a second
     * walk of sysfs. A caller arriving while one of these is in flight is
     * replayed against a fresh sweep as before, so a handed-in inventory is
     * only ever used by the call that loaded it.
     */
    discoverAsync(onDone, inventory) {
        if (this._destroyed)
            return;
        if (this._discovering) {
            /* This caller arrived after the current inventory began. Its
             * promise belongs to the replay that observes everything up to
             * this request, not to the older snapshot already in flight. */
            if (onDone)
                this._discoverNextWaiters.push(onDone);
            this._discoverAgain = true;
            return;
        }
        if (onDone)
            this._discoverWaiters.push(onDone);
        this._discovering = true;
        let adopt = snapshot => {
            if (this._destroyed)
                return;
            this._discovering = false;
            this._adopt(snapshot.sensors, snapshot.counters, snapshot.topology,
                        snapshot.directPowers);
            let waiters = this._discoverWaiters.splice(0);
            for (let waiter of waiters)
                waiter(true);
            this._onChanged();

            if (this._discoverAgain) {
                this._discoverAgain = false;
                this._discoverWaiters = this._discoverNextWaiters.splice(0);
                this.discoverAsync();
            } else {
                /* A refresh requested during discovery checks the completed
                 * snapshot instead of queuing another complete sweep before
                 * that snapshot has even established its topology. */
                this._refresh.resume();
            }
        };
        if (inventory)
            Scan.snapshotFromInventoryAsync(inventory, adopt, this._io);
        else
            Scan.discoverSnapshotAsync(adopt, this._io);
    }

    _adopt(found, counters, topology, directPowers) {
        /* One assignment boundary: a reading sees the complete old machine or
         * the complete new one, never half of each. */
        this.temperatureSensors = found.temperatures;
        this.fanSensors = found.fans;
        this.powerSensors = found.powerMeters.concat(directPowers || []);
        /* The meters keep the previous counter value between polls, so they
         * outlive a reading and are only rebuilt by a rediscovery. */
        this.energyMeters = counters.map(counter => new Energy.EnergyMeter(counter));
        this._topology = topology;
    }

    /*
     * A cheap description of what is present: the three roots, one shallow
     * listing per hwmon and thermal device, and access metadata for the few
     * powercap counters. This catches both whole devices and sensor channels
     * moving inside an existing device; installing the optional RAPL rule
     * changes the access metadata.
     */
    _topologyKey() {
        let directories = Scan.directoryInventory();
        return Scan.topologyFromInventory(directories, IO.readString, IO.readLink, IO.canRead);
    }

    /*
     * Checks for hardware that has come or gone, and sweeps again only if
     * there is any. Both modes answer the caller: synchronous sets return
     * whether they swept and call onDone with the same answer, asynchronous
     * sets return that the request was accepted and answer onDone when the
     * check lands. The callback used to be dropped on the synchronous branch,
     * so one of the two contracts silently left its caller waiting.
     *
     * The comparison includes the stable metadata and device links that give
     * those nodes meaning. Moving readings are excluded.
     */
    refresh(onDone) {
        if (this._destroyed)
            return false;
        if (!this._asynchronous) {
            let swept = this._topologyKey() !== this._topology;
            if (swept)
                this.discover();
            if (onDone)
                onDone(swept);
            return swept;
        }

        /* The inventory in flight may have begun before this request, so one
         * later check covers every overlapping caller; see lib/refresh.js. */
        return this._refresh.request(onDone);
    }

    /* One shallow walk of the three roots, and a full sweep only where it
     * shows the machine has changed. */
    _sweep(done) {
        Scan.loadInventoryAsync(inventory => {
            if (this._destroyed)
                return;
            if (Scan.inventoryTopology(inventory) === this._topology) {
                done(false);
                return;
            }
            /* The machine changed, and this sweep already holds everything
             * the snapshot is built from. */
            this.discoverAsync(() => done(true), inventory);
        }, this._io);
    }

    /* Every caller accepted before teardown is answered once, unsuccessfully:
     * cancelled I/O may never reach its ordinary completion. The first throw
     * is handed back rather than swallowed or allowed to strand the rest. */
    destroy() {
        if (this._destroyed)
            return null;
        this._destroyed = true;
        this._onChanged = function () {};
        this._discovering = false;
        this._discoverAgain = false;
        let waiters = this._discoverWaiters.splice(0)
            .concat(this._discoverNextWaiters.splice(0));
        let firstError = null;
        for (let waiter of waiters) {
            try {
                waiter(false);
            } catch (error) {
                firstError = firstError || error;
            }
        }
        /* After the discoveries, in the order they were accepted in: a
         * topology check is asked for behind a discovery, never in front of
         * one. */
        firstError = firstError || this._refresh.stop();
        this.temperatureSensors = [];
        this.fanSensors = [];
        this.powerSensors = [];
        this.energyMeters = [];
        return firstError;
    }
};

/*
 * What a set of discovered sensors reads, given the numbers behind them.
 *
 * A function of an inventory and a way of getting a value: hand it the same
 * lists and the same values and it says the same thing, whether those values
 * came one file read at a time or out of a batch that was loaded off the main
 * loop. That is why read() and readAsync() cannot drift - there is one
 * assembly and two sources for it.
 *
 * The one thing it remembers is which unlabelled fans have been seen turning,
 * which is a judgement about the hardware rather than about this reading: a
 * fan that has spun once is wired, and stays wired after it stops.
 */
const SensorReader = class SensorReader {
    /* `lists` answers the current inventory as { temperatures, fans, meters,
     * powers }. */
    constructor(lists) {
        this._lists = lists || (() => ({ temperatures: [], fans: [], meters: [], powers: [] }));
        /* Held here rather than on the discovered records because a
         * rediscovery replaces those wholesale, which would drop a fan that
         * has spun and since stopped out of the menu. */
        this._fansThatHaveRun = new Set();
    }

    temperature(sensor, readNumber) {
        let fault = sensor.faultPath ? readNumber(sensor.faultPath) : 0;
        let raw = fault !== null && fault > 0 ? null : readNumber(sensor.path);
        return {
            id: sensor.id,
            measure: sensor.measure,
            chip: sensor.chip,
            /* what the driver calls it, which is what anything picking a
             * sensor by name has to match on */
            rawLabel: sensor.rawLabel,
            kind: sensor.kind,
            label: Format.sensorLabel(sensor),
            /* what the chip is called, and what this reading is called under
             * that heading; see _groupName and _shortName */
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            shortLabel: sensor.short,
            critical: sensor.critical,
            celsius: raw === null ? null : raw / 1000,
        };
    }

    _selectTemperatures(keep, sensors) {
        let fallbackDevices = new Set();
        for (let sensor of sensors) {
            if (sensor.fallbackForDevice && keep(sensor))
                fallbackDevices.add(sensor.fallbackForDevice);
        }
        let primary = sensors.filter(sensor => !sensor.fallbackForDevice &&
            (keep(sensor) || (sensor.deviceIdentity &&
                              fallbackDevices.has(sensor.deviceIdentity))));
        let primaryDevices = new Set(primary
            .map(sensor => sensor.deviceIdentity)
            .filter(device => !!device));
        let fallbacks = sensors.filter(sensor => sensor.fallbackForDevice &&
            (keep(sensor) || primaryDevices.has(sensor.fallbackForDevice)));
        return { primary: primary, fallbacks: fallbacks };
    }

    temperatures(keep, readNumber, lists) {
        let found = lists || this._lists();
        let selected = this._selectTemperatures(keep, found.temperatures);
        let readings = selected.primary.map(sensor => ({
            sensor: sensor,
            reading: this.temperature(sensor, readNumber),
        }));
        let validDevices = new Set(readings
            .filter(item => item.reading.celsius !== null && item.sensor.deviceIdentity)
            .map(item => item.sensor.deviceIdentity));
        let result = readings.map(item => item.reading);
        for (let sensor of selected.fallbacks) {
            if (!validDevices.has(sensor.fallbackForDevice))
                result.push(this.temperature(sensor, readNumber));
        }
        return result;
    }

    fan(sensor, readNumber) {
        let fault = sensor.faultPath ? readNumber(sensor.faultPath) : 0;
        let rpm = fault !== null && fault > 0 ? null : readNumber(sensor.path);
        if (rpm !== null && rpm > 0)
            this._fansThatHaveRun.add(sensor.id);
        return {
            id: sensor.id,
            measure: sensor.measure,
            chip: sensor.chip,
            rawLabel: sensor.rawLabel,
            kind: sensor.kind,
            label: Format.sensorLabel(sensor),
            group: sensor.group,
            groupLabel: sensor.groupLabel,
            shortLabel: sensor.short,
            /* A label is the driver's declaration that this input is wired.
             * An unlabelled input earns the same status after it has produced
             * a non-zero reading, and keeps it when the fan later stops. */
            inUse: !!sensor.rawLabel || this._fansThatHaveRun.has(sensor.id),
            rpm: rpm,
        };
    }

    powers(keep, readNumber, lists) {
        let found = lists || this._lists();
        let readings = [];
        let packageWatts = null;

        for (let meter of found.meters) {
            if (!keep(meter))
                continue;
            meter.sample(undefined, readNumber);
            if (meter.watts === null)
                continue;
            readings.push({
                id: meter.id,
                measure: meter.measure,
                kind: meter.kind,
                label: meter.label,
                group: meter.group,
                groupLabel: Kinds.kindLabel(meter.kind),
                shortLabel: meter.label,
                watts: meter.watts,
            });
            /* The sub-domains are inside the top level ones, so adding both
             * would count the same joules twice. */
            if (meter.topLevel)
                packageWatts = (packageWatts || 0) + meter.watts;
        }

        for (let sensor of found.powers) {
            if (!keep(sensor))
                continue;
            let raw = readNumber(sensor.path);
            if (raw === null && sensor.fallbackPath)
                raw = readNumber(sensor.fallbackPath);
            if (raw === null)
                continue;
            readings.push({
                id: sensor.id,
                measure: sensor.measure,
                kind: sensor.kind,
                label: Format.sensorLabel(sensor),
                group: sensor.group,
                groupLabel: sensor.groupLabel,
                shortLabel: sensor.short,
                /* Only this kind of channel may be aggregated across devices;
                 * discovery leaves ambiguous rails false. */
                deviceTotal: !!sensor.deviceTotal,
                /* A DTPM root is the aggregate for the platform subtree. */
                platformTotal: !!sensor.platformTotal,
                /* hwmon reports microwatts */
                watts: raw / 1000000,
            });
        }

        return { readings: readings, packageWatts: packageWatts };
    }

    _appendPaths(paths, sensors, keep, secondary) {
        for (let sensor of sensors) {
            if (!keep(sensor))
                continue;
            paths.push(sensor.path);
            if (secondary && sensor[secondary])
                paths.push(sensor[secondary]);
        }
    }

    /* Every node one reading touches, for whoever wants to load them first. */
    paths(keep, lists) {
        let found = lists || this._lists();
        let paths = [];
        let temperatures = this._selectTemperatures(keep, found.temperatures);
        this._appendPaths(paths, temperatures.primary.concat(temperatures.fallbacks),
                          () => true, "faultPath");
        this._appendPaths(paths, found.fans, keep, "faultPath");
        for (let meter of found.meters)
            if (keep(meter))
                paths.push(meter.counter.path);
        this._appendPaths(paths, found.powers, keep, "fallbackPath");
        return paths;
    }

    assemble(keep, readNumber, lists) {
        let found = lists || this._lists();
        let powers = this.powers(keep, readNumber, found);
        return {
            temperatures: this.temperatures(keep, readNumber, found),
            fans: found.fans.filter(keep).map(sensor => this.fan(sensor, readNumber)),
            powers: powers.readings,
            packageWatts: powers.packageWatts,
        };
    }

};

/*
 * The sensors of one machine: what was found, and what they read now.
 *
 * Two objects underneath - an inventory that knows what is there, and a
 * reader that turns values into readings - and one filesystem scope, which is
 * what a poll's batch and a discovery sweep both hang off and what teardown
 * cancels.
 */
const SensorSet = class SensorSet {
    constructor(options) {
        let configuration = options || {};
        this._destroyed = false;
        this._ioScope = new IO.AsyncScope();
        this._ioOptions = { scope: this._ioScope };
        this._inventory = new SensorInventory({
            asynchronous: configuration.asynchronous,
            onChanged: configuration.onChanged,
            io: this._ioOptions,
        });
        this._reader = new SensorReader(() => this._inventory.lists());
        this._inventory.start();
    }

    get temperatureSensors() {
        return this._inventory.temperatureSensors;
    }

    get fanSensors() {
        return this._inventory.fanSensors;
    }

    get powerSensors() {
        return this._inventory.powerSensors;
    }

    get energyMeters() {
        return this._inventory.energyMeters;
    }

    discover() {
        this._inventory.discover();
    }

    discoverAsync(onDone, inventory) {
        this._inventory.discoverAsync(onDone, inventory);
    }

    refresh(onDone) {
        return this._inventory.refresh(onDone);
    }

    /* What was discovered, as one thing that can be held on to. */
    _lists() {
        return this._inventory.lists();
    }

    /*
     * One value per sensor, as of now - but only for the sensors `wanted`
     * says yes to.
     *
     * That filter is not an optimisation detail, it is most of the cost of a
     * poll. Reading a disk temperature wakes the drive: on the machine this
     * was written on, nvme and drivetemp nodes take between 0.1 and 1.6
     * milliseconds each while every other sensor takes about 50 microseconds,
     * and those are exactly the ones the menu hides by default. Reading them
     * anyway meant spending nine tenths of every poll on numbers that were
     * then filtered out.
     *
     * Without a filter everything is read, which is what discovery-only
     * callers want.
     */
    read(wanted) {
        let keep = wanted || (() => true);
        return this._reader.assemble(keep, IO.readNumber);
    }

    /*
     * The same reading, without holding up the caller.
     *
     * Every node the reading will touch is loaded first, all at once and off
     * the main loop, and then the reading is assembled out of what came back.
     * That is the whole difference: read() and readAsync() share one assembly,
     * so a value can only be understood one way, and what changes is where the
     * bytes came from.
     *
     * It matters because a sysfs read is not reliably quick. On the machine
     * this was written on, reading every sensor takes about a tenth of a
     * millisecond each for the chips that are awake and tens of milliseconds
     * in total once the disks are included, because reading a drive's
     * temperature wakes the drive. Synchronously, in the process that draws
     * the desktop, that is several dropped frames every poll.
     *
     * The energy meters take their elapsed time when the reading is assembled
     * rather than when the counter was read. Those are a few milliseconds
     * apart against an interval of seconds, which the watts figure does not
     * notice.
     */
    readAsync(wanted, onDone) {
        let keep = wanted || (() => true);
        /* Answers exactly once, including here. A destroyed set has no reading
         * to give, which is not the same as having no answer to give: the
         * applet's collection holds an in-flight flag that only the answer
         * lowers, so a promise dropped rather than kept leaves the panel on
         * its last picture and every later poll returning at that guard. This
         * used to return, and only the order of teardown - _destroyed raised
         * before the backends are taken apart - kept it from happening. That
         * is a fact about today's callers rather than about this method; every
         * other backend here settles the same path on the way out. */
        if (this._destroyed) {
            if (onDone)
                onDone(null);
            return;
        }
        /*
         * The lists are taken now, not when the answer comes back.
         *
         * A rediscovery can land in between - the poll asks for one every
         * minute, opening the menu asks for one every time - and it replaces
         * every list on this object. The paths were collected before the read
         * and the reading used to be assembled out of whatever the lists held
         * afterwards, so a sweep in the middle meant looking up new sensors in
         * an answer keyed by the old ones: every value missing, and one poll
         * where the whole machine read null.
         *
         * Both callers refresh before they update, so it takes the two to slip
         * past each other - an update deferred by an in-flight read finishing
         * after the next tick's sweep. Rare, and it costs one array of
         * references to make impossible.
        */
        let found = this._lists();
        let finish = Once.once(answer => onDone(answer));
        IO.readStringsAsync(this._reader.paths(keep, found), values => {
            if (this._destroyed) {
                finish(null);
                return;
            }
            finish(this._reader.assemble(keep, path => IO.toNumber(values[path]), found));
        }, 32, null, this._ioOptions);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._ioScope.cancel();
        let firstError = this._inventory.destroy();
        if (firstError)
            throw firstError;
    }
};
