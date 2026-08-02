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
