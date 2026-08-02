# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Seventh pass

Every source file, the helper, the schema, the polkit action, the Makefile and
the workflow read again after the hardware naming, the per-monitor brightness
sliders and the two column menu went in. Build output, caches and `.git`
skipped; the project has no generated files. The first two rows are older than
that work and were found by looking outside the applet for once.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-99 | low | S | **UPower's own sensor readings carry none of the grouping the rest of them do.** `lib/upower.js` `_sensorReadings` builds battery temperatures and drains without `group`, `groupLabel` or `shortLabel`, so they reach the menu through the fallbacks in `_withHeadings` and `_rowLabel`. It reads correctly - one "Battery" heading, the device's own title on each row - but it is the only path through the sensor list that no test covers, and it is the one that will break silently when the grouping changes again. |
| PT-100 | low | XS | A battery reporting exactly 0 °C is dropped rather than shown: `lib/upower.js` gates on `if (device.temperature)` and `lib/device.js` `describe` does the same. Freezing is a reading, and a device that has just come in from a car in winter is when somebody would want it. The same `if (value)` shape guards `energyRate`, `voltage`, `capacity` and `cycles` there, where zero mostly does mean nothing. |
| PT-101 | low | XS | The "Only the first %d monitors have a slider" row is a plain `InfoRow` sitting among the sliders at full row weight. It is a note about the list, not a reading in it, and should be quieter than the rows it follows. |
| PT-102 | low | XS | `SHORT_LABELS` in [lib/sensors.js](cinnamon-powertoys@geraldo-netto/lib/sensors.js) passes translated strings as the replacement argument of `String.replace`, where `$&`, `$1` and `$'` are substitution patterns rather than characters. A translator who writes a `$` gets a mangled sensor name. Only `CCD $1` needs the substitution; the rest can be returned as they stand. |
| PT-103 | low | XS | [lib/hardware.js](cinnamon-powertoys@geraldo-netto/lib/hardware.js) remembers that a PCI address has no name for the life of the applet. An external graphics card, or anything else that appears at an address already asked about, keeps showing the raw address until a reload. A missing table is already treated as "not known yet" rather than "no such device"; a missing entry could be too, at the cost of one table read per rediscovery. |
| PT-104 | low | XS | `DdcBacklight._onChanged` is stored in the constructor and never called from anywhere, while the applet passes it a live callback that would re-sync the sliders. Either the group should use it when a monitor's value moves under it - which is the only way a change made with the monitor's own buttons could ever reach the menu - or the parameter should go, because as it stands it promises a notification that never arrives. |

## Documentation drift

The applet changed shape; the things that describe it did not.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-93 | medium | S | [docs/menu.png](docs/menu.png) is a picture of a menu that no longer exists: one column, *Processor* and *Sensors* as collapsed submenus, no brightness sliders, no version on the configure row. Two layouts have gone past it since - three titled panels, then the strip, the per-monitor sliders and the two columns that are there now - and it is the README's only image. **Needs somebody at the machine.** Opening the menu from D-Bus and capturing its rectangle - with `gnome-screenshot`, or with `org.Cinnamon.ScreenshotArea` called from inside the shell - photographs whatever window is above it, because a menu opened that way is open in Cinnamon's model without being raised over a fullscreen window. `docs/panel.png` wants retaking at the same time: the README already admits it predates temperature leaving the panel label. |
