# Cinnamon Power Toys

A Cinnamon applet that puts a single power icon in the panel and, from one
menu, monitors and configures power management for the whole machine.

## Features

**Batteries, every device type.** Everything UPower knows about is listed, not
just the laptop battery: mice, keyboards, headsets, game controllers, phones,
tablets, UPS units, styluses. Each row shows charge, state, time remaining,
draw in watts, voltage, temperature, health (capacity versus design capacity)
and charge cycles when the device reports them. Devices that only report a
coarse level (low / normal / high) are shown that way instead of a fake
percentage.

**Power profiles.** Reads and switches profiles through power-profiles-daemon
(both the `net.hadess.PowerProfiles` and `org.freedesktop.UPower.PowerProfiles`
names are supported). Shows when the firmware degrades performance and which
application is holding a profile. On machines without the daemon it falls back
to the ACPI platform profile in `/sys/firmware/acpi/platform_profile`.

**CPU.** Current and maximum frequency, scaling driver (including the
`amd_pstate` mode), governor, energy performance preference and turbo boost.
Governor, energy preference, boost and the battery charge limit are kernel
owned, so they are applied through a small validating helper launched with
`pkexec`.

**Temperature and power.** Every hwmon and thermal zone sensor plus fan speeds,
hwmon power meters (for example the amdgpu GPU package power) and RAPL package
power when the kernel allows reading it. Sensors are grouped and can be limited
to CPU and GPU only.

**Alerts.** Configurable low and critical battery notifications, separate
thresholds for peripherals, and an optional high temperature warning. All with
hysteresis, so a value sitting on the limit does not spam the tray.

**Panel.** Choose what appears next to the icon: battery percentage,
temperature, power draw, CPU frequency, active profile, any combination. The
icon follows the battery level, the active profile, or stays fixed. Optional
keyboard shortcuts to cycle the profile and to open the menu, and an optional
scroll-to-change-profile action.

## Install

```sh
./install.sh          # or: make install
```

Then restart Cinnamon (`Alt+F2`, `r`, Enter) and enable **Power Toys** from
*Right click panel → Applets*.

To remove it:

```sh
make uninstall
```

## Permissions

Reading is entirely unprivileged. Changing the CPU governor, energy preference,
turbo boost or charge limit writes to root owned files in `/sys`, so those
actions call `powertoys-helper` through `pkexec` and an administrator password
is requested. The helper accepts five fixed commands and validates every value
against the list the kernel advertises, so it cannot be used to write arbitrary
data. Turn the whole group off with *Allow changing CPU governor…* in the
applet settings if you would rather not be asked.

RAPL energy counters (`/sys/class/powercap/*/energy_uj`) are root-only on most
kernels since CVE-2020-8694. When they are unreadable the package power row is
simply not shown; battery draw and GPU power still work.

## Requirements

- Cinnamon 5.4 or newer
- UPower (for battery and device data)
- power-profiles-daemon, optional, for profile switching
- polkit, optional, for the privileged controls

## Layout

```
cinnamon-powertoys@geraldo-netto/
├── applet.js            panel item, menu, polling, alerts
├── lib/io.js            file reads, rooted so a captured /sys can stand in
├── lib/sensors.js       hwmon, thermal and powercap discovery
├── lib/sysfs.js         cpufreq and power supply nodes
├── lib/upower.js        UPower D-Bus client
├── lib/profiles.js      power-profiles-daemon client
├── lib/format.js        value formatting and UPower enum naming
├── powertoys-helper     validating pkexec helper for root owned settings
├── settings-schema.json
├── stylesheet.css
└── icons/
```

## License

MIT, see [LICENSE](LICENSE).
