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
| PT-23 | medium | S | No CI. A small workflow running `sh -n` on the helper, JSON validation on the two schema files and the `cjs` parse check on the five JavaScript files would catch every class of error that showed up during development. |
| PT-27 | medium | M | No tests. The throwaway smoke script used during development (sensor discovery, CPU control read-out, profile client, UPower snapshot) covers the risky parts and runs under plain `cjs`; move it into `tests/` and wire it to `make check`. |
| PT-27b | low | XS | Cases for `lib/format.js`, which is pure: units, thresholds, durations, the UPower enum names and the profile and governor label tables. No system access needed, so these can run anywhere. |
| PT-27d | low | XS | A smoke case for the UPower monitor and the profile client against the live daemons, skipped rather than failed when they are not on the bus, so CI without a system bus stays green. |
| PT-32 | medium | M | One of the two clusters left in the applet class that are more than wiring. The two profile backends are stitched together rather than made interchangeable. `PowerProfilesClient` and `PowerSupply.platformProfile()` have different shapes, so `_collect()` unions them behind a `viaSysfs` flag (`_collectProfile()` in [applet.js](cinnamon-powertoys@geraldo-netto/applet.js)) and `_setProfile()` re-reads that flag to pick the write path (`_setProfile()` in [applet.js](cinnamon-powertoys@geraldo-netto/applet.js)). |
| PT-32a | medium | S | Add a `PlatformProfileClient` alongside `PowerProfilesClient` with the same `available` / `active` / `list` / `setProfile()` surface, writing through the pkexec helper and reading the ACPI nodes. On its own this changes no behaviour. |
| PT-32b | medium | XS | Choose the backend once — at startup and whenever the daemon appears or vanishes — and the `viaSysfs` flag, the union in `_collect()` and the branch in `_setProfile()` all go away. |
| PT-52 | low | XS | Two install paths that have already diverged: `make install` ([Makefile:15-20](Makefile#L15-L20)) and [install.sh](install.sh) perform the same copy and `chmod`, but only the script reloads the running applet. Have the Makefile target call the script. |

## Laws of UX

A pass over the interface against [lawsofux.com](https://lawsofux.com/), naming
the law each finding sits under. Nothing here is a malfunction; every row is
about what the interface asks of the person reading it.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-55 | medium | M | **Miller's Law, Chunking, Law of Common Region.** With *Include disk, network and board sensors* on, the Sensors submenu is 19 rows in one undifferentiated column — measured on this machine. They are already sorted by kind and each kind already carries a label that nothing renders (`KINDS` in [lib/sensors.js](cinnamon-powertoys@geraldo-netto/lib/sensors.js)), so a heading per kind is a few lines and turns one list of nineteen into four lists of two to seven. It also gives `kindLabel()` the caller PT-49 could not find for it. |
| PT-57 | medium | S | **Serial Position Effect.** The last row of the menu is the one people remember and reach for, and it holds `Power Toys 1.0.0`, which cannot be acted on. The two things that can — *System power settings* and *Configure Power Toys* — sit above it. Put the version in the settings window or on the configure row and give the end of the menu back to an action. |
| PT-58 | medium | S | **Peak-End Rule.** Changing a governor, an energy preference, the boost switch or the charge limit reports failures and says nothing at all on success. So the memorable end of the interaction is a password prompt followed by silence, and the only confirmation is noticing the menu now reads differently. |
| PT-59 | medium | XS | **Postel's Law, feedback.** A *Preferred CPU sensor* hint that matches nothing falls through to automatic selection without a word. The person who typed it has no way to tell whether it took effect. Mark the chosen sensor in the menu, or say in the settings window that the hint matched nothing. |
| PT-60 | medium | XS | **Cognitive Load.** *Scaling driver: amd-pstate-epp (active)* is kernel vocabulary in a menu aimed at anyone. Governors and energy preferences already go through label tables in [lib/format.js](cinnamon-powertoys@geraldo-netto/lib/format.js); the driver row does not. |
| PT-61 | medium | S | **Jakob's Law.** The applet this one can replace, `power@cinnamon.org`, changes screen brightness when the wheel is used over it and toggles the keyboard backlight on a middle click. Here the wheel does nothing unless *Mouse wheel over the applet* is changed from its default, and middle click does nothing at all. Someone switching applets silently loses two gestures they already have. |
| PT-62 | medium | S | **Paradox of the Active User.** Nobody reads the README first. On a desktop the applet is now an icon with no text beside it, and the two richest parts of the menu are behind submenus that are folded by default. There is nothing on first run that says what it can do. |
| PT-63 | low | XS | **Von Restorff Effect.** Bold now marks three different things: the summary line, the group headings, and a warning. The one that is supposed to stand out is the one competing with the other two. |
## Bugs and incongruences

A pass looking for things that are wrong rather than things that are untidy.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-65 | medium | XS | The *Preferred CPU sensor* tooltip still says the hint chooses "the sensor used for the panel temperature". The panel stopped showing a temperature when that was taken out of the label; the hint now governs the tooltip, the menu summary and the processor row instead. Introduced by that change and missed by it. |
| PT-66 | medium | XS | `AlertPolicy` never forgets a device that goes away. An entry is dropped from `_alerted` only when the device is seen again above its limit, so a headset unplugged while low keeps its entry for the life of the session — and if it comes back at the same level it will not warn again. Drop entries whose path is not in the reading. |
| PT-67 | low | XS | The helper's boost writer is the one setter that does not report its own failure. `set_governor` and `set_charge_threshold` count successful writes and `die` with a message; `set_boost` writes directly, so a rejected write aborts under `set -e` with nothing on stderr and the applet shows its generic message. |
| PT-69 | low | XS | The icon theme is asked once per name and the answer is kept for the life of the applet ([lib/format.js](cinnamon-powertoys@geraldo-netto/lib/format.js)), so switching to a theme that does or does not carry the xapp set is not noticed until a reload. |
| PT-70 | low | XS | The charge limit is read from sysfs on every poll whether or not privileged controls are on and whether or not the menu is open — the one reading still taken for something that cannot currently be shown. |
| PT-71 | low | XS | An accepted profile change polls twice: `_setProfile()` schedules an update inside the D-Bus callback and again immediately after issuing it. |
| PT-72 | low | XS | Opening the menu calls `UPowerMonitor.refresh()`, which asks UPower to re-poll every system battery. On a laptop that is a real device poll on every menu open, for data that arrives by signal anyway. |
| PT-73 | low | XS | The panel can say the same thing twice. With no battery the icon source resolves to `profile`, so the coloured gauge already shows which profile is active, and *Show active power profile in the panel* then repeats it in words beside it. |
## Architecture, performance and robustness

A pass over shape rather than behaviour: coupling, cost, timing, teardown and
state. Vectorisation has no purchase here — there is no bulk numeric work
anywhere in the applet; its cost is entirely file and bus IO, which is what
these rows are about.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-75 | medium | M | Everything runs on the compositor's main loop: ten milliseconds of synchronous `open`/`read`/`close` every four seconds, in the process that draws the desktop, on a machine where one of those reads can block for over a millisecond on a sleeping disk. `GLib.file_get_contents_async` exists. |
| PT-77 | medium | S | A profile change has no pending state. Between the click and the daemon answering, the menu still shows the old selection, so a second click sends a second write for a change that is already in flight. The same is true of every helper-backed control. |
| PT-78 | medium | S | Nothing serialises the privileged helper. Two quick clicks spawn two `pkexec` processes and can put two password dialogs on screen for two settings, each finishing with its own refresh. |
| PT-79 | low | S | The reading is rebuilt from nothing on every poll and no one compares it to the last. With the menu closed the panel is the only consumer, and it re-formats identical text every four seconds. |
| PT-81 | low | XS | Cinnamon's module loader is re-implemented twice — in [tools/parse-check.js](tools/parse-check.js) and in [tests/harness.js](tests/harness.js) — with the same two regexes and the same wrapper in both. One of them should use the other. |
