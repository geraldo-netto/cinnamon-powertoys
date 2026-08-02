# Cinnamon Power Toys

A Cinnamon applet that puts a single power icon in the panel and, from one
menu, monitors and configures power management for the whole machine.

![The menu](docs/menu.png)

The panel item, between the other applets:

![The panel item](docs/panel.png)

Captured on a desktop, so two things are not in the shot because that machine
does not have them: the charger row, which needs a UPower line power device,
and the backlight sliders, which need a backlight. Both hide themselves.

## Features

**Batteries, every device type.** Everything UPower knows about is listed, not
just the laptop battery: mice, keyboards, headsets, game controllers, phones,
tablets, UPS units, styluses. Each row shows charge, state, time remaining,
draw in watts, voltage, temperature, health (capacity versus design capacity)
and charge cycles when the device reports them. Devices that only report a
coarse level (low / normal / high) are shown that way instead of a fake
percentage. Chargers are listed above them, by model where UPower knows it,
so whether the machine is on the cable is the first line in the menu.

**Brightness.** Screen and keyboard backlight sliders at the top of the menu,
driven through `org.cinnamon.SettingsDaemon.Power.Screen` and `.Keyboard`, so
the wheel over one moves in the same steps the brightness keys do. Each is
hidden on a machine that does not have that backlight.

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

### One prompt instead of one per change

Out of the box every one of those changes asks for the password again, because
`pkexec` with no policy of its own never keeps an authorisation. Changing the
governor, the energy preference and the charge limit in one visit to the menu
is three prompts.

```sh
sudo make install-policy      # optional
```

That installs two files:

| file | what it is |
|------|------------|
| `/usr/share/polkit-1/actions/io.github.geraldo-netto.cinnamon-powertoys.policy` | the action |
| `/usr/local/lib/cinnamon-powertoys/powertoys-helper` | a root owned copy of the helper |

**What the action grants.** An administrator, logged in at the machine, may run
that one helper as root, and the authorisation is remembered for a few minutes
afterwards (`auth_admin_keep`) rather than for a single call. Anyone who is not
an administrator is still asked for an administrator password, and anyone
inactive or connected remotely gets no keeping at all. It grants nothing else:
the helper takes five fixed commands and checks every value against the list
the kernel itself advertises.

**Why the second file.** A kept authorisation applies to a path, so that path
must be one its caller cannot rewrite while the authorisation is still valid.
The copy inside the applet lives under your home directory; the action
deliberately names a root owned copy instead. Re-run `sudo make install-policy`
after upgrading the applet so the two stay the same script.

**To revoke it:**

```sh
sudo make uninstall-policy
```

Both files go, and the applet carries on asking for a password on every
change.

## Requirements

- Cinnamon 5.4 or newer. Only 6.6 has been run. 5.4 through 6.4 are checked by
  reading the Cinnamon sources at each release for every call this applet
  makes: the xlet `require()` loader, `PopupSubMenuMenuItem`,
  `PopupSwitchMenuItem`, `PopupSliderMenuItem`, `PopupIconMenuItem`,
  `addActor`, `addSettingsAction`, class-based applets, `AllowedLayout`,
  `AppletSettings.bind`, `spawnCommandLineAsyncIO`, `Tooltips.Tooltip`,
  `keybindingManager.addHotKey`, `criticalNotify`, and the `=` operator in a
  settings-schema `dependency`. All of them are present and unchanged in 5.4.0.
- UPower, for battery and device data
- `xapp-symbolic-icons`, for the device and battery icons. Cinnamon's own power
  applet only started using these names in 6.6, so on an older desktop that
  package may not be installed and those icons will be missing. Nothing else is
  affected.
- power-profiles-daemon, optional, for profile switching
- polkit, optional, for the privileged controls

## Layout

```
cinnamon-powertoys@geraldo-netto/
├── applet.js            panel item, menu, polling, alerts
├── lib/io.js            file reads, rooted so a captured /sys can stand in
├── lib/sensors.js       hwmon, thermal and powercap discovery
├── lib/backlight.js     screen and keyboard backlight through csd
├── lib/cpu.js           cpufreq scaling interface
├── lib/power-supply.js  charge limit and ACPI platform profile nodes
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
