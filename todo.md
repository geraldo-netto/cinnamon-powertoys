# Power Toys — review findings

Review of every source file in the repository (applet, libraries, helper
script, packaging, docs). Build output, caches and `.git` were skipped; the
project has no generated files.

PT-12 to PT-29 come from the first pass, which looked for defects and gaps.
PT-30 onwards come from a second pass over the same files looking only at
architecture, coupling, SOLID and complexity — nothing there is a malfunction,
every item is about the shape of the code.

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-27 | medium | M | No tests. The throwaway smoke script used during development (sensor discovery, CPU control read-out, profile client, UPower snapshot) covers the risky parts and runs under plain `cjs`; move it into `tests/` and wire it to `make check`. |
| PT-27d | low | XS | A smoke case for the UPower monitor and the profile client against the live daemons, skipped rather than failed when they are not on the bus, so CI without a system bus stays green. |

## Laws of UX

A pass over the interface against [lawsofux.com](https://lawsofux.com/), naming
the law each finding sits under. Nothing here is a malfunction; every row is
about what the interface asks of the person reading it.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-57 | medium | S | **Serial Position Effect.** The last row of the menu is the one people remember and reach for, and it holds `Power Toys 1.0.0`, which cannot be acted on. The two things that can — *System power settings* and *Configure Power Toys* — sit above it. Put the version in the settings window or on the configure row and give the end of the menu back to an action. |
| PT-63 | low | XS | **Von Restorff Effect.** Bold now marks three different things: the summary line, the group headings, and a warning. The one that is supposed to stand out is the one competing with the other two. |
## Bugs and incongruences

A pass looking for things that are wrong rather than things that are untidy.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-73 | low | XS | The panel can say the same thing twice. With no battery the icon source resolves to `profile`, so the coloured gauge already shows which profile is active, and *Show active power profile in the panel* then repeats it in words beside it. |
## Architecture, performance and robustness

A pass over shape rather than behaviour: coupling, cost, timing, teardown and
state. Vectorisation has no purchase here — there is no bulk numeric work
anywhere in the applet; its cost is entirely file and bus IO, which is what
these rows are about.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-75 | medium | M | Everything runs on the compositor's main loop: ten milliseconds of synchronous `open`/`read`/`close` every four seconds, in the process that draws the desktop, on a machine where one of those reads can block for over a millisecond on a sleeping disk. `GLib.file_get_contents_async` exists. |
| PT-79 | low | S | The reading is rebuilt from nothing on every poll and no one compares it to the last. With the menu closed the panel is the only consumer, and it re-formats identical text every four seconds. |
