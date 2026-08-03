# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

The fifteenth pass read every tracked source again — the applet, the fourteen
libraries, the helper, the policy, the udev rule, the schema, the install
script and the workflow — asking what the two machines this is written for do
differently: the laptop with a daemon and the one with only firmware. Most of
what it found is on the second of those, which is the path nobody develops on.
The leak sweep it also carried came up empty: every signal is disconnected
where it was connected, every timer is removed on the way out, and the four
caches that outlive a poll — the alert set, the PCI names, the icon answers,
the device map — are each pruned or bounded. The one thing it did find that
holds a resource is PT-155, and that one holds a file descriptor rather than
memory.

## Profiles

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-153 | medium | S | The wheel and the hotkey step profiles in an order the machine did not offer, and it is the wrong one on exactly the machines the fallback exists for. [`_orderedProfiles`](cinnamon-powertoys@geraldo-netto/applet.js#L2780) puts the three names in [`PROFILE_ORDER`](cinnamon-powertoys@geraldo-netto/lib/profiles.js#L39) first and appends everything else, on the reasoning that stepping should always run power saver, balanced, performance. That reasoning is power-profiles-daemon's, whose `Profiles` property is already in that order — so on the daemon the sort changes nothing, and it was never tested against anything else. The ACPI platform profile is what it changes: `platform_profile_choices` reads `low-power balanced performance` on a ThinkPad and `quiet balanced performance` elsewhere, none of which is in the list, so the whole firmware list is "unusual" but for `balanced` and `performance` and comes out as balanced, performance, low-power. Scrolling up from balanced gives performance and then the *lowest* profile the machine has; scrolling down from balanced is clamped, so the low profile is only reachable by going up twice. Worse, [`SegmentedControl.sync`](cinnamon-powertoys@geraldo-netto/applet.js#L1494) draws `data.profile.list` in the backend's own order, so the buttons on screen read low-power, balanced, performance while the wheel walks them in another — one control, two orders. Both backends already list their profiles low to high, which is the whole of the fix: step the backend's list, and keep PROFILE_ORDER for what it is actually needed for, which is naming the three the applet knows. |

## Backends and lifecycle

| id | severity | effort | description |
|----|----------|--------|-------------|

## The file no gate can see

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-161 | high | M | [applet.js](cinnamon-powertoys@geraldo-netto/applet.js) is 3117 lines against 5308 in the libraries — 37% of the JavaScript — and neither gate reaches a line of it. [`tools/mutate.js`](tools/mutate.js#L199) builds its file list from `lib/` alone, and the coverage run measures the copies it writes of those same libraries, so "410 functions, every one at 80% or better" and "84% of mutants caught" are both statements about the other 63%. The eleventh pass made this argument once and `lib/alerts.js` and `lib/reading.js` came out of it; what is left in there that is not wiring is the same kind of thing they were — a function of a reading and the options in force, with no widget in it — and it is where PT-153 has been sitting unseen. Split as below, each part a move plus the cases that could not have been written before it. |
| PT-161c | medium | S | The two settings decisions: [`_panelText`](cinnamon-powertoys@geraldo-netto/applet.js#L2605) and [`_migratePanelText`](cinnamon-powertoys@geraldo-netto/applet.js#L2634), which is a one-way upgrade path over three old switches that runs exactly once per install and can never be run again to see whether it was right. It reads four settings and writes one; given those four as arguments it is a pure choice between four names. |
