/*
 * cinnamon-powertoys - the names the profile backends are known by.
 *
 * A backend name is written by the module that talks to that backend and read
 * by the pure derivations that decide what the menu may offer. Keeping the
 * names here is what stops a derivation from having to require a whole
 * backend - and its D-Bus and sysfs machinery - to compare one string.
 */

/*
 * What the ACPI platform-profile backend answers when a reading asks where its
 * profiles came from. It is compared against, not just displayed: that backend
 * writes firmware and never touches cpufreq, so unlike power-profiles-daemon
 * it does not own the governor or the energy preference, and the menu has to
 * be able to tell.
 */
const PLATFORM_BACKEND = "acpi-platform-profile";
