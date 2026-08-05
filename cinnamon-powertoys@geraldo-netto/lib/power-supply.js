/*
 * cinnamon-powertoys - power supply and firmware nodes.
 *
 * The battery charge limit exposed by the laptop vendor drivers, and the ACPI
 * platform profile used when power-profiles-daemon is not running. Both are
 * absent on most desktops, which is why each lookup answers null rather than
 * throwing.
 */

const IO = require("./lib/io.js");

var POWER_SUPPLY_DIR = "/sys/class/power_supply";
var PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
var PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

/*
 * What this backend answers when a reading asks where its profiles came from.
 * It is compared against, not just displayed: this backend writes firmware and
 * never touches cpufreq, so unlike power-profiles-daemon it does not own the
 * governor or the energy preference, and the menu has to be able to tell.
 */
var PLATFORM_BACKEND = "acpi-platform-profile";

/*
 * The charge limit, across every battery that has one.
 *
 * Every battery, not the first. The helper writes the threshold to all of
 * them - a laptop with a main battery and a bay battery wants both moved
 * together, which is what somebody picking one number from one menu means -
 * and a control that wrote two and read one would show the first battery's
 * number and call it both. So the read is the same set as the write.
 *
 * The values are read every time they are asked for rather than captured
 * once: the firmware, a vendor tool or another copy of this applet can move
 * them, and a value remembered from startup would quietly disagree with the
 * hardware.
 *
 * Writing needs root, so it goes to a runner the caller supplies - in the
 * applet, the pkexec helper - which keeps the read and the write of one
 * setting in the same place.
 */
var ChargeControl = class ChargeControl {
    /* `batteries` is every battery that exposes an end threshold, as
     * { name, path }, in the order they were found. */
    constructor(batteries, runner) {
        this.batteries = batteries || [];
        this._runner = runner || function () {};
    }

    /* One per battery, in that order, null for one that will not answer now. */
    get limits() {
        return this.batteries.map(battery => IO.readNumber(battery.path));
    }

    /*
     * What those come to, in one look rather than two.
     *
     * `state` keeps three materially different reasons for a null limit apart:
     * every readable battery agrees, every battery answered but disagrees, or
     * at least one did not answer. The menu can offer a corrective write for
     * the latter two without pretending an incomplete read is disagreement.
     */
    reading() {
        let values = this.limits;
        let readable = values.filter(value => value !== null);
        let agreed = readable.length === values.length && readable.length > 0 &&
                     readable.every(value => value === readable[0]);
        let incomplete = readable.length !== values.length || values.length === 0;
        let divided = !incomplete && !agreed;
        return {
            limits: values,
            limit: agreed ? readable[0] : null,
            state: agreed ? "agreed" : divided ? "divided" : "incomplete",
            agreed: agreed,
            divided: divided,
            incomplete: incomplete,
            readableCount: readable.length,
            batteryCount: values.length,
        };
    }

    get limit() {
        return this.reading().limit;
    }

    setLimit(percent, onDone) {
        this._runner(["charge-threshold", String(percent)], onDone);
    }
};

/*
 * Charge limit support, as exposed by thinkpad_acpi, asus-wmi, huawei-wmi and
 * friends. Only the end threshold is offered, it is the one that matters for
 * battery longevity.
 */
function discoverChargeControl(runner) {
    let batteries = [];
    for (let name of IO.listDir(POWER_SUPPLY_DIR)) {
        let base = POWER_SUPPLY_DIR + "/" + name;
        if (IO.readString(base + "/type") !== "Battery")
            continue;
        let endPath = base + "/charge_control_end_threshold";
        if (!IO.exists(endPath))
            continue;
        batteries.push({ name: name, path: endPath });
    }
    return batteries.length > 0 ? new ChargeControl(batteries, runner) : null;
}

/* ACPI platform profile, used as a fallback when power-profiles-daemon is absent. */
function platformProfile() {
    if (!IO.exists(PLATFORM_PROFILE))
        return null;
    return {
        active: IO.readString(PLATFORM_PROFILE),
        choices: IO.readWords(PLATFORM_PROFILE_CHOICES),
    };
}

/*
 * The ACPI platform profile, wearing the same face as PowerProfilesClient.
 *
 * The two are not alike underneath - one is a daemon on the system bus, the
 * other is two files in /sys written through a root helper - and the applet
 * used to know that, unioning their two shapes behind a flag and then reading
 * that flag back to decide how to write. Given the same surface, it does not
 * have to: it holds one of these and asks it.
 */
var PlatformProfileClient = class PlatformProfileClient {
    constructor(runner) {
        this._runner = runner || function () {};
    }

    /* Read every time: the firmware moves this on its own - a lid closed, a
     * charger unplugged - and vendor tools write it too. */
    _read() {
        return platformProfile();
    }

    get available() {
        let profile = this._read();
        return profile !== null && profile.choices.length > 0;
    }

    /* What this backend is, for a reading that wants to say where its
     * profiles came from. */
    get busName() {
        return PLATFORM_BACKEND;
    }

    get active() {
        let profile = this._read();
        return profile === null ? null : profile.active;
    }

    get profiles() {
        let profile = this._read();
        return profile === null ? [] : profile.choices;
    }

    /* The firmware says nothing about either of these; the daemon does. */
    get degraded() {
        return "";
    }

    get holds() {
        return [];
    }

    /*
     * Everything a reading asks about the profile, from one look at the
     * firmware.
     *
     * The getters above are each a fresh read, which is right when one of them
     * is what you want and wrong when all of them are: a poll asking for six
     * properties opened the same two files three times over. This is the call
     * a poll makes.
     */
    snapshot() {
        let profile = this._read();
        return {
            available: profile !== null && profile.choices.length > 0,
            busName: this.busName,
            active: profile === null ? null : profile.active,
            profiles: profile === null ? [] : profile.choices,
            degraded: "",
            holds: [],
        };
    }

    /*
     * Writing needs root, so it goes through the same runner every other
     * privileged setting uses. The helper checks the value against the
     * firmware's own list before writing it.
     */
    setProfile(name, onResult) {
        let done = onResult || function () {};
        this._runner(["platform-profile", String(name)], outcome => {
            if (!outcome || outcome.applied)
                done(null);
            else if (outcome.cancelled)
                done(new Error("cancelled"));
            else
                done(new Error(outcome.error || "the change could not be applied"));
        });
        return true;
    }

    /*
     * Nothing to release: this backend is two files and a runner it was
     * handed. It exists so that the applet can tear every backend down the
     * same way, without knowing which of them happen to hold something.
     */
    destroy() {
    }
};
