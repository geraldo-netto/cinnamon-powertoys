# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## External monitors

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-147 | low | XS | The probe timer runs on machines where a probe can never fire. [`_watchMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2055) arms on any reason, and the guard that decides whether looking is even allowed — the setting on, no kernel backlight — lives in [`_probeMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2093), inside the tick. So on every laptop with a kernel backlight, which is most machines, each hover and every open menu spins a once-a-second timer whose every tick does nothing, against a comment that says the timer does not exist while there is nobody to spend it on. Checking the same condition before arming closes it; the condition can change while a reason is held (the settings daemon answers late, the setting is toggled), so either re-ask at those two moments — both already reach [`_considerMonitorBacklight`](cinnamon-powertoys@geraldo-netto/applet.js#L2006) — or accept one no-op tick and stop the timer from inside it. |

## Seams and contracts

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-149 | low | S | The two backlight kinds claim one face and answer differently. lib/ddc.js promises — and tests — that every ask is answered exactly once, because the group counts callbacks down. `BacklightControl` does not: [`setPercentage`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L138) and [`toggle`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L158) return without a word when there is no proxy, and [`refresh`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L118) drops its `done` when destroyed mid-flight. Today's callers survive it — the slider is hidden while there is no proxy, and a destroyed applet has stopped listening — but "answers to the same handful of members" is the contract a future caller will code against, and the cheap fix is to answer `done()` on every path, which is what the ddc side already pays for. [`UPowerMonitor.destroy`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L384) has the same drift from the other side: every other backend lowers `available` on destroy and it does not. |
| PT-150 | low | XS | [`BluezBatteries._dbusCall`](cinnamon-powertoys@geraldo-netto/lib/bluez.js#L186) reaches `Gio.DBus.system` with nothing catching, and it is called from the constructor's first `_refresh()`. On a machine with no system bus that getter throws — tests/cases/live.js wraps the same call in a try for exactly this — and a throw there ends the applet's constructor: no icon, nothing on the panel. lib/upower.js wraps its equivalent; `_subscribe` in this same file wraps its own. One try around the call, answering `onDone(null)`, makes no-bus read as bluetoothd-not-running, which is what the module already treats as ordinary. |
| PT-151 | low | XS | A monitor that appears while the menu is open can land in a hidden column. [`syncBacklights`](cinnamon-powertoys@geraldo-netto/applet.js#L1327) shows the brightness group when a slider arrives, but [`_syncColumns`](cinnamon-powertoys@geraldo-netto/applet.js#L1412) — which decides whether the first column is visible at all — only runs on a full `update()`. Where profile and processor groups are both hidden (no daemon, `show-cpu` off), the group that just appeared sits in a column that stays invisible for up to a refresh interval. One `_syncColumns()` at the end of `syncBacklights` closes it; the method is already idempotent and cheap. |
| PT-152 | low | XS | The comment over [`_readChargeLimit`](cinnamon-powertoys@geraldo-netto/applet.js#L2313) says opening the menu "re-reads before anything is drawn", and the code draws first: [`_onMenuOpened`](cinnamon-powertoys@geraldo-netto/applet.js#L2413) paints from `_latest`, which was assembled with the menu shut and so carries `chargeLimit: null`, and the re-read lands milliseconds later with the dot. The blip is invisible in practice; the sentence is the problem, because it is the reasoning the next reader will extend. Either read the limit synchronously in `_onMenuOpened` before the first paint — it is two file reads — or say what actually happens. |

