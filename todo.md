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
| PT-103 | low | XS | [lib/hardware.js](cinnamon-powertoys@geraldo-netto/lib/hardware.js) remembers that a PCI address has no name for the life of the applet. An external graphics card, or anything else that appears at an address already asked about, keeps showing the raw address until a reload. A missing table is already treated as "not known yet" rather than "no such device"; a missing entry could be too, at the cost of one table read per rediscovery. |
| PT-104 | low | XS | `DdcBacklight._onChanged` is stored in the constructor and never called from anywhere, while the applet passes it a live callback that would re-sync the sliders. Either the group should use it when a monitor's value moves under it - which is the only way a change made with the monitor's own buttons could ever reach the menu - or the parameter should go, because as it stands it promises a notification that never arrives. |

## Documentation drift

The applet changed shape; the things that describe it did not.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-93 | medium | S | [docs/menu.png](docs/menu.png) is a picture of a menu that no longer exists: one column, *Processor* and *Sensors* as collapsed submenus, no brightness sliders, no version on the configure row. Two layouts have gone past it since - three titled panels, then the strip, the per-monitor sliders and the two columns that are there now - and it is the README's only image. **Needs somebody at the machine.** Opening the menu from D-Bus and capturing its rectangle - with `gnome-screenshot`, or with `org.Cinnamon.ScreenshotArea` called from inside the shell - photographs whatever window is above it, because a menu opened that way is open in Cinnamon's model without being raised over a fullscreen window. `docs/panel.png` wants retaking at the same time: the README already admits it predates temperature leaving the panel label. |
