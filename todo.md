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

## Seams and contracts

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-150 | low | XS | [`BluezBatteries._dbusCall`](cinnamon-powertoys@geraldo-netto/lib/bluez.js#L186) reaches `Gio.DBus.system` with nothing catching, and it is called from the constructor's first `_refresh()`. On a machine with no system bus that getter throws — tests/cases/live.js wraps the same call in a try for exactly this — and a throw there ends the applet's constructor: no icon, nothing on the panel. lib/upower.js wraps its equivalent; `_subscribe` in this same file wraps its own. One try around the call, answering `onDone(null)`, makes no-bus read as bluetoothd-not-running, which is what the module already treats as ordinary. |
| PT-152 | low | XS | The comment over [`_readChargeLimit`](cinnamon-powertoys@geraldo-netto/applet.js#L2313) says opening the menu "re-reads before anything is drawn", and the code draws first: [`_onMenuOpened`](cinnamon-powertoys@geraldo-netto/applet.js#L2413) paints from `_latest`, which was assembled with the menu shut and so carries `chargeLimit: null`, and the re-read lands milliseconds later with the dot. The blip is invisible in practice; the sentence is the problem, because it is the reasoning the next reader will extend. Either read the limit synchronously in `_onMenuOpened` before the first paint — it is two file reads — or say what actually happens. |

