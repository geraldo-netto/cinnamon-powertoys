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
 * The charge limit of one battery.
 *
 * `limit` is read every time it is asked for rather than captured once: the
 * firmware, a vendor tool or another copy of this applet can move it, and a
 * value remembered from startup would quietly disagree with the hardware.
 *
 * Writing it needs root, so it goes to a runner the caller supplies - in the
 * applet, the pkexec helper - which keeps the read and the write of one
 * setting in the same place.
 */
var ChargeControl = class ChargeControl {
    constructor(battery, path, runner) {
        this.battery = battery;
        this.path = path;
        this._runner = runner || function () {};
    }

    get limit() {
        return IO.readNumber(this.path);
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
    for (let name of IO.listDir(POWER_SUPPLY_DIR)) {
        let base = POWER_SUPPLY_DIR + "/" + name;
        if (IO.readString(base + "/type") !== "Battery")
            continue;
        let endPath = base + "/charge_control_end_threshold";
        if (!IO.exists(endPath))
            continue;
        return new ChargeControl(name, endPath, runner);
    }
    return null;
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
        return "acpi-platform-profile";
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

    destroy() {
    }
};
