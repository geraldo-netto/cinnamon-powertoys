# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Twelfth pass — state machines, in-flight work, lifetimes

GJS has one thread for the code and several underneath it: every D-Bus call,
every spawned process and every `load_contents_async` answers later, on a main
loop that has gone on running in between. So this pass asked what is in flight,
what can start twice, what can be replaced while something is still holding the
old one, and which flags have no way back. The libraries hold nine small state
machines between them; these are the ones with a hole in.

## State machines

| id | severity | effort | description |
|----|----------|--------|-------------|

## Concurrency

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-137 | low | S | [`SensorSet.refresh()`](cinnamon-powertoys@geraldo-netto/lib/sensors.js#L655) can replace the sensor lists while a [`readAsync`](cinnamon-powertoys@geraldo-netto/lib/sensors.js#L786) is still out. The paths are collected before the read and `_assemble` walks `this.temperatureSensors` *after* it, so a rediscovery in between assembles the new lists out of values keyed by the old paths and every lookup misses — one poll where every sensor reads null. Both callers refresh before updating, which is why this needs the two to slip: an update deferred by `_collectAgain` finishes after the next tick's refresh. Rare, self-correcting on the next poll, and avoidable by taking the lists at read time rather than at assembly time. |

## Architecture

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-138 | low | S | [`KeyedList`](cinnamon-powertoys@geraldo-netto/applet.js#L423) is the last thing in `applet.js` that decides something rather than drawing it, and it decides the one thing that keeps the menu from flickering: whether a section is rebuilt or its rows updated in place. It needs nothing of a menu but `removeAll` and `addMenuItem`. Its [`_signature`](cinnamon-powertoys@geraldo-netto/applet.js#L442) length-prefixes each key specifically so that no two different sets can produce the same string — the keys are device paths, sensor ids and profile names, none of which promises to avoid a separator — and that argument is asserted nowhere. `lib/keyed-list.js`, with a stub section that records what it was told. |

## Closed

The eleventh pass asked where the seams are, what has to agree with what, and
what is wired to nothing. Its seven rows are closed between `286327a` and
`4cb4bbb`. The first was the shape of the project: 43% of
the JavaScript sat in the one file no case can load, so `lib/alerts.js` and
`lib/reading.js` are what came out of it, and applet.js is 3161 lines down to
2932. Two of the remaining rows were paid for by that move within the hour —
the battery-threshold clamp and the profile-drawn helper are both covered now
by cases that could not have been written the day before.

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
