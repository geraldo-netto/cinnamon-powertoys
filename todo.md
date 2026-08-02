# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Sixth pass

Every source file read again after the asynchronous poll, the three-panel menu
and the typographic changes went in. Build output, caches and `.git` skipped;
the project has no generated files. Most of what is below was introduced by
that work rather than found surviving from before it.

| id | severity | effort | description |
|----|----------|--------|-------------|

## Documentation drift

The applet changed shape; the things that describe it did not.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-93 | medium | S | [docs/menu.png](docs/menu.png) is a picture of a menu that no longer exists: one column, *Processor* and *Sensors* as collapsed submenus, no brightness sliders, no version on the configure row. Two layouts have gone past it since - three titled panels, then the strip, the per-monitor sliders and the two columns that are there now - and it is the README's only image. **Needs somebody at the machine.** Opening the menu from D-Bus and capturing its rectangle - with `gnome-screenshot`, or with `org.Cinnamon.ScreenshotArea` called from inside the shell - photographs whatever window is above it, because a menu opened that way is open in Cinnamon's model without being raised over a fullscreen window. `docs/panel.png` wants retaking at the same time: the README already admits it predates temperature leaving the panel label. |
