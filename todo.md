# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Tenth pass — the whole tree again, after the ninth was closed

Every tracked file, this time including the two tools the ninth pass only ran:
the loader emulation was read against Cinnamon's own `fileUtils.js` line by
line, and the shipped SVGs, the translation scripts and the parse check were
read as sources. The code the ninth pass changed was re-read as new code. The
suite is at 218 passing and the tree is clean; none of what follows is a
regression from this session's commits except where the row says so.

## Behaviour

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-124 | medium | S | Switching *Control external monitor brightness* off does nothing until a reload. The setting's handler calls [`_considerMonitorBacklight`](cinnamon-powertoys@geraldo-netto/applet.js#L2171), which only ever starts the probe — there is no off path — so the sliders stay in the menu and [`_brightnessControl`](cinnamon-powertoys@geraldo-netto/applet.js#L3024) goes on handing the wheel to the monitors, both against a setting that says off. The tooltip promises "turn the probe off with…", and the one thing somebody who has just switched it off will check is whether the sliders went. On off: destroy the `DdcBacklight` (or hide its sliders and make `_brightnessControl` read the setting), and rebuild it on the next on. |

## Ninth pass — closed

The ninth pass read every tracked file except the fixtures and the two
screenshots, and all ten of its rows are closed in the run of commits between
`a945999` and `a823395` in the log. Two of them found more than they were
opened for: the first case written against the new profiles seam caught a
property being unpacked twice per read, and moving the doc blocks turned up a
fifth that had drifted the same way.
