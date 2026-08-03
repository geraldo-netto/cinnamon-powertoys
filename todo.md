# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

## Two answers arriving in the wrong order

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-171 | medium | S | [`UPowerMonitor._addDevice`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L294) guards on `this._devices.has(path)`, and that map is only written when the proxy answers — so the guard is blind for the whole round trip, and two things go wrong inside it. A path announced twice in that window (the enumeration racing a `DeviceAdded`, a dock reconnecting) builds two proxies: the second overwrites the map entry, the first keeps its `g-properties-changed` handler, and from then on every property change is two redraws for the life of the session, with `destroy()` unable to reach the orphan because the map no longer names it. And a `DeviceRemoved` inside the same window finds nothing to remove, so the add lands afterwards and the device stays in the list — a headset switched off during enumeration keeps its menu row until the applet is reloaded. The case in [tests/cases/upower.js](tests/cases/upower.js) called "a device announced twice is proxied once" cannot reach either: its `busFor` answers `device()` synchronously unless `holdDevices` is set, so the map is already written by the time the second announcement arrives. Marking the path as in flight before the call closes both, and the same fixture already has `holdDevices` for the cases that would then be worth writing. |

## The helper's own words

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-173 | low | XS | [`set_charge_threshold`](cinnamon-powertoys@geraldo-netto/powertoys-helper#L167) reads the start threshold and compares it as a number without checking that it is one: `current_start=$(cat "$start" …)` falls back to `0` only when the read fails, so a node that answers with an empty string or anything non-numeric reaches `[ "$current_start" -ge "$value" ]`, which ends the script under `set -eu` with the shell's own "integer expression expected". [`write_node`](cinnamon-powertoys@geraldo-netto/powertoys-helper#L72) exists precisely so that every way this script can fail is a line this script wrote — the applet reports the last line of stderr as the reason — and this is the one arithmetic that escapes it. The same `''|*[!0-9]*` case the argument itself is checked with, applied to what was read. |

## Comments that no longer describe the code

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-174 | low | XS | [`labelText`](cinnamon-powertoys@geraldo-netto/lib/panel-text.js#L126) spends a paragraph explaining that the frequency was taken out of the panel text, and then illustrates the separator with `"97% 12 W 4.30 GHz Balanced"` — a string this function can no longer produce. The example is the part of a comment that gets read; leave it naming the three parts that are still there. |
