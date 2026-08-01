# Power Toys — review findings

Review of every source file in the repository (applet, libraries, helper
script, packaging, docs). Build output, caches and `.git` were skipped; the
project has no generated files.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

| id | effort | description |
|----|--------|-------------|
| PT-08 | S | The per-device `g-properties-changed` handler is never disconnected ([lib/upower.js:170](cinnamon-powertoys@geraldo-netto/lib/upower.js#L170)); `DeviceRemoved` only drops the map entry and `destroy()` clears the map. Keep the handler id per proxy and disconnect it in both places. |
| PT-12 | S | `high-temp-threshold` is always entered in °C while the whole UI can be showing °F. Either convert on read or label the spinner with the active unit. |
| PT-13 | S | The panel shows bare watts while the menu qualifies the same number as "(GPU)" or "(package)". On a desktop with no RAPL access the panel reads 54 W, which looks like whole-system draw but is the graphics card. Add a short marker or an explicit tooltip line. |
| PT-14 | M | There is no AC adapter row. `lineDevices()` is already collected in `_collect()` and only used for a tooltip sentence; a row showing charger online/offline (and the adapter model, where UPower has it) is nearly free. |
| PT-15 | M | No brightness controls. The stock `power@cinnamon.org` applet carries screen and keyboard backlight sliders through `org.cinnamon.SettingsDaemon.Power.Screen` / `.Keyboard`; anyone replacing that applet with this one loses them. |
| PT-16 | S | A failed profile switch is only written to the Looking Glass log ([lib/profiles.js](cinnamon-powertoys@geraldo-netto/lib/profiles.js)); the menu keeps showing the old dot with no explanation. Surface the error with `Main.notifyError`. |
| PT-17 | S | Scroll-to-change-profile has no debounce and no feedback ([applet.js:1003](cinnamon-powertoys@geraldo-netto/applet.js#L1003)). One flick of the wheel sends several D-Bus property writes. Coalesce on a short timeout and show the resulting profile, the way `_cycleProfile()` does. |
| PT-18 | M | `_updateMenu()` runs on every poll even when the menu is closed ([applet.js:707](cinnamon-powertoys@geraldo-netto/applet.js#L707)), rebuilding label text for rows nobody can see. Update the panel always, the menu only while `this.menu.isOpen`, plus once on open. |
| PT-19 | S | `CpuControl.averageFrequency()` reads one file per cpufreq policy ([lib/sysfs.js:430](cinnamon-powertoys@geraldo-netto/lib/sysfs.js#L430)) — 32 reads per tick on this machine — even when neither the panel nor the menu shows frequency. Read it lazily, or sample a subset of policies. |
| PT-20 | S | Opening the menu re-runs the whole `discoverSensors()` sweep synchronously ([applet.js:566](cinnamon-powertoys@geraldo-netto/applet.js#L566)): every hwmon directory listed, every label file read. Cache the topology and rediscover on a slower cadence, or only when the device set changed. |
| PT-21 | M | No `po/` directory and no `.pot`, although every string goes through `_()` and `make pot` exists. Without the template neither the applet strings nor the settings-schema descriptions can be translated. Run `cinnamon-xlet-makepot`, commit the template, document how to add a locale. |
| PT-22 | M | No polkit policy, so every governor, energy-preference, boost or charge-limit change asks for the password again. Ship a `.policy` action for the helper with `auth_admin_keep`, install it under `/usr/share/polkit-1/actions` from a documented root install target, and keep the current per-call prompt as the fallback. |
| PT-23 | S | No CI. A small workflow running `sh -n` on the helper, JSON validation on the two schema files and the `cjs` parse check on the five JavaScript files would catch every class of error that showed up during development. |
| PT-24 | S | README and `metadata.json` claim Cinnamon 5.4 and newer; only 6.6 was actually exercised. Verify the oldest supported release (in particular `PopupSubMenuMenuItem`, `PopupSwitchMenuItem` and class-based applets) or narrow the claim. |
| PT-25 | XS | README has no screenshot, which is the quickest way to convey what the applet does; panel and menu captures already exist from the review session. |
| PT-26 | XS | `metadata.json` has no `url`, and nothing in the UI shows the version. Add the repository URL and a version line, useful once this is submitted to the Spices. |
| PT-27 | M | No tests. The throwaway smoke script used during development (sensor discovery, CPU control read-out, profile client, UPower snapshot) covers the risky parts and runs under plain `cjs`; move it into `tests/` and wire it to `make check`. |
| PT-28 | XS | The warning colour is hard-coded `#f57900` in [stylesheet.css](cinnamon-powertoys@geraldo-netto/stylesheet.css), which can clash with dark or high-contrast themes. Prefer a theme colour, or document the choice. |
