# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Eleventh pass — architecture, coupling, wiring

Not another sweep for defects in the small: this one asked where the seams are,
what has to agree with what, and what is wired to nothing. The first row is the
shape of the project and the rest are things that fall out of it.

## Architecture

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-128 | medium | M | [applet.js](cinnamon-powertoys@geraldo-netto/applet.js) is 3161 lines against 4228 for all sixteen libraries — 43% of the JavaScript in the one file that cannot be loaded outside Cinnamon, because it opens with `imports.ui.applet`. So none of it is executed by any case: `tests/cases/settings.js` reads it *as text*, which is the tell. That is not only the widgets. About three hundred lines in it decide things and touch nothing on screen, and every library under it was given a seam precisely so its decisions could be checked. The parts below are ordered so each is a smaller file than the last. |
| PT-128c | low | S | [`_pickTemperature`](cinnamon-powertoys@geraldo-netto/applet.js#L2479) and [`_pickPower`](cinnamon-powertoys@geraldo-netto/applet.js#L2512) are methods only because they read `this.cpuSensorHint`; pass it in and they are functions of a list. Between them they choose the number in the panel tooltip and the number the high-temperature alert fires on, by a preference order — `tctl`, `tdie`, `package id 0`, `cpu` — that is asserted nowhere. |

## Wiring and congruence

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-130 | low | XS | Three places ask which profile to draw and two of them call [`shownProfile`](cinnamon-powertoys@geraldo-netto/applet.js#L222). [`_updateProfiles`](cinnamon-powertoys@geraldo-netto/applet.js#L1680) spells `options.pendingProfile \|\| data.profile.active` out again instead. It is the same expression today; the helper exists so that it stays the same tomorrow. |
| PT-131 | low | XS | `DdcBacklight`'s doc says onReady "is called once, when the first probe has finished". Since PT-124 that is no longer true — `stop()` then `start()` probes again and calls it again — and it was already beside the point, because the applet passes `() => this._onBacklightChanged()` as *both* onReady and onChanged, so the distinction the class draws is used by nobody. Say what it now does, or collapse the two into one callback. Mine to fix: the contract went stale in this session. |

## Closed

The tenth pass read every tracked file again, this time including the two tools
the ninth pass had only run: the loader emulation was compared against
Cinnamon's own `fileUtils.js`, and the shipped SVGs, the translation scripts
and the parse check were read as sources. Its four rows are closed between
`e0ec291` and `c0279c6`. Three of the four were in the
paths that answer to hardware that is not there — a monitor that will not take
a write, a bluetooth daemon that stops, a setting switched off — which is where
this applet's failure cases nearly all live, because on the machine it is
written on none of them happen.

The ninth pass read every tracked file except the fixtures and the two
screenshots, and all ten of its rows are closed in the run of commits between
`a945999` and `a823395`. Two of them found more than they were opened for: the
first case written against the new profiles seam caught a property being
unpacked twice per read, and moving the doc blocks turned up a fifth that had
drifted the same way.
