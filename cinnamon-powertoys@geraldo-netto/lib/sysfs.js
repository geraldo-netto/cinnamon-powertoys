/*
 * cinnamon-powertoys - sysfs access layer.
 *
 * Reading and listing live in lib/io.js, sensor discovery in lib/sensors.js
 * and the scaling interface in lib/cpu.js; what is left here is the two power
 * supply lookups. Everything is best effort: a node that is missing, root-only
 * or busy yields null instead of throwing, so the caller can simply hide that
 * row.
 */

const IO = require("./lib/io.js");

var POWER_SUPPLY_DIR = "/sys/class/power_supply";
var PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
var PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";

/*
 * Charge limit support, as exposed by thinkpad_acpi, asus-wmi, huawei-wmi and
 * friends. Only the end threshold is offered, it is the one that matters for
 * battery longevity.
 */
function discoverChargeControl() {
    for (let name of IO.listDir(POWER_SUPPLY_DIR)) {
        let base = POWER_SUPPLY_DIR + "/" + name;
        if (IO.readString(base + "/type") !== "Battery")
            continue;
        let endPath = base + "/charge_control_end_threshold";
        if (!IO.exists(endPath))
            continue;
        return {
            battery: name,
            path: endPath,
            value: IO.readNumber(endPath),
        };
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
