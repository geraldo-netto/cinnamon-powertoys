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
| PT-146 | medium | S | A probe is not held off by a monitor already mid-conversation, and the two meet on the bus. PT-145c serialised probe against probe; nothing serialises a probe against the per-monitor reads and writes that `_busy` guards, and the applet now lines the two up as a matter of course: [`open-state-changed`](cinnamon-powertoys@geraldo-netto/applet.js#L2169) runs [`_onMenuOpened`](cinnamon-powertoys@geraldo-netto/applet.js#L2413), whose backlight refresh sends a getvcp to every monitor, and then starts the watch, whose first probe fires at once — a `detect` across every bus while those reads are still on it. A drag is the same collision once a second: setvcp in flight, tick, detect. Two ddcutil on one bus is how ddcutil comes back with nothing (PT-135), so every menu open on a DDC machine risks reads that answer nothing — kept values, so it heals silently, but the noise is built in. The shape of the fix is in [`redetect`](cinnamon-powertoys@geraldo-netto/lib/ddc.js#L512): drop the probe while any monitor is `_busy`, the same way one landing inside a probe is dropped — the next tick is a second away. A case belongs beside the PT-145c ones. |
| PT-147 | low | XS | The probe timer runs on machines where a probe can never fire. [`_watchMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2055) arms on any reason, and the guard that decides whether looking is even allowed — the setting on, no kernel backlight — lives in [`_probeMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2093), inside the tick. So on every laptop with a kernel backlight, which is most machines, each hover and every open menu spins a once-a-second timer whose every tick does nothing, against a comment that says the timer does not exist while there is nobody to spend it on. Checking the same condition before arming closes it; the condition can change while a reason is held (the settings daemon answers late, the setting is toggled), so either re-ask at those two moments — both already reach [`_considerMonitorBacklight`](cinnamon-powertoys@geraldo-netto/applet.js#L2006) — or accept one no-op tick and stop the timer from inside it. |
| PT-148 | low | XS | The panel wheel writes to monitors that have never answered, from a value it invents. [`_moveEach`](cinnamon-powertoys@geraldo-netto/lib/ddc.js#L665) asks every monitor in the list, and a monitor that never answered a getvcp has `percentage` null, so `stepBy` starts it from 50 — a number from nowhere, written to hardware that has already declined to talk, refused, and logged one line per flick. The sliders already draw the line — "a monitor that has never answered is not offered" — and the group write should honour the same one: skip monitors where `known` is false. The deliberate wake-by-writing case is the slider's, and a never-answered monitor has no slider. |

## Seams and contracts

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-149 | low | S | The two backlight kinds claim one face and answer differently. lib/ddc.js promises — and tests — that every ask is answered exactly once, because the group counts callbacks down. `BacklightControl` does not: [`setPercentage`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L138) and [`toggle`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L158) return without a word when there is no proxy, and [`refresh`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L118) drops its `done` when destroyed mid-flight. Today's callers survive it — the slider is hidden while there is no proxy, and a destroyed applet has stopped listening — but "answers to the same handful of members" is the contract a future caller will code against, and the cheap fix is to answer `done()` on every path, which is what the ddc side already pays for. [`UPowerMonitor.destroy`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L384) has the same drift from the other side: every other backend lowers `available` on destroy and it does not. |
| PT-150 | low | XS | [`BluezBatteries._dbusCall`](cinnamon-powertoys@geraldo-netto/lib/bluez.js#L186) reaches `Gio.DBus.system` with nothing catching, and it is called from the constructor's first `_refresh()`. On a machine with no system bus that getter throws — tests/cases/live.js wraps the same call in a try for exactly this — and a throw there ends the applet's constructor: no icon, nothing on the panel. lib/upower.js wraps its equivalent; `_subscribe` in this same file wraps its own. One try around the call, answering `onDone(null)`, makes no-bus read as bluetoothd-not-running, which is what the module already treats as ordinary. |
| PT-151 | low | XS | A monitor that appears while the menu is open can land in a hidden column. [`syncBacklights`](cinnamon-powertoys@geraldo-netto/applet.js#L1327) shows the brightness group when a slider arrives, but [`_syncColumns`](cinnamon-powertoys@geraldo-netto/applet.js#L1412) — which decides whether the first column is visible at all — only runs on a full `update()`. Where profile and processor groups are both hidden (no daemon, `show-cpu` off), the group that just appeared sits in a column that stays invisible for up to a refresh interval. One `_syncColumns()` at the end of `syncBacklights` closes it; the method is already idempotent and cheap. |
| PT-152 | low | XS | The comment over [`_readChargeLimit`](cinnamon-powertoys@geraldo-netto/applet.js#L2313) says opening the menu "re-reads before anything is drawn", and the code draws first: [`_onMenuOpened`](cinnamon-powertoys@geraldo-netto/applet.js#L2413) paints from `_latest`, which was assembled with the menu shut and so carries `chargeLimit: null`, and the re-read lands milliseconds later with the dot. The blip is invisible in practice; the sentence is the problem, because it is the reasoning the next reader will extend. Either read the limit synchronously in `_onMenuOpened` before the first paint — it is two file reads — or say what actually happens. |

## Closed

PT-145 was opened on its own rather than as part of a pass, and asked when it is
worth going to look for a monitor the desktop never announced. Its four rows are
closed between `c46b413` and `d290024`. The answer it settled on is that the
applet being looked at is what pays for the probe: the menu open or the pointer
on the icon holds a one second timer up, and the timer does not exist otherwise.
The row that had to land first was the one nobody would have opened on its own —
a probe was calling itself finished when the detect answered, with the reads it
had just started still out, which only becomes a collision once something asks
every second.

The thirteenth pass asked which guards test for an answer the live system never
gives, and what happens to the thing that arrives while its backend is busy
with the one before. Its six rows are closed between `160fe62` and `8925a9a`.
Three of them were a value quietly thrown away by a guard that was right to
refuse it and wrong to forget it — the brightness a drag ends on, the read of
the BlueZ tree a signal asked for, and, the other way round, two guards that
could not refuse anything because they tested a UPower percentage against null
and it is never null. The one that reached furthest was the smallest change:
lib/profiles.js was asking the system bus for the daemon synchronously, on the
thread that draws the desktop, and had been since it was written.

The twelfth pass asked what is in flight, what can start twice, what can be
replaced while something still holds the old one, and which flags have no way
back. Its six rows are closed between `4c780b9` and `d327587`. Four were
races that only open when two asynchronous things slip past each other, which
is why none of them had ever been seen: a queued pkexec outliving the applet,
two ddcutil calls on one bus, a wheel flick outrunning a monitor, and a
rediscovery landing inside a reading.

The eleventh pass asked where the seams are, what has to agree with what, and
what is wired to nothing. Its seven rows are closed between `286327a` and
`4cb4bbb`. The first was the shape of the project: 43% of the JavaScript sat
in the one file no case can load, so `lib/alerts.js` and `lib/reading.js` are
what came out of it, and applet.js is 3161 lines down to 2932. Two of the
remaining rows were paid for by that move within the hour — the
battery-threshold clamp and the profile-drawn helper are both covered now by
cases that could not have been written the day before.

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
