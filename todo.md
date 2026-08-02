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
| PT-32 | medium | M | One of the three clusters left in the applet class that are more than wiring. The two profile backends are stitched together rather than made interchangeable. `PowerProfilesClient` and `Sysfs.platformProfile()` have different shapes, so `_collect()` unions them behind a `viaSysfs` flag ([applet.js:481-503](cinnamon-powertoys@geraldo-netto/applet.js#L481-L503)) and `_setProfile()` re-reads that flag to pick the write path ([applet.js:1017-1025](cinnamon-powertoys@geraldo-netto/applet.js#L1017-L1025)). |
| PT-32a | medium | S | Add a `PlatformProfileClient` alongside `PowerProfilesClient` with the same `available` / `active` / `list` / `setProfile()` surface, writing through the pkexec helper and reading the ACPI nodes. On its own this changes no behaviour. |
| PT-32b | medium | XS | Choose the backend once — at startup and whenever the daemon appears or vanishes — and the `viaSysfs` flag, the union in `_collect()` and the branch in `_setProfile()` all go away. |
| PT-37 | medium | S | One of the three clusters left in the applet class that are more than wiring. `_runHelper()` does five jobs — the settings gate, the existence check, the executable-bit repair, the spawn, and the exit-code-to-notification policy ([applet.js:1085-1120](cinnamon-powertoys@geraldo-netto/applet.js#L1085-L1120)) — and returns silently when privileged controls are off, so a caller whose switch is visible cannot tell the difference between applied and ignored. Extract a `PrivilegedHelper` class and leave the gate to the caller. |
| PT-52 | low | XS | Two install paths that have already diverged: `make install` ([Makefile:15-20](Makefile#L15-L20)) and [install.sh](install.sh) perform the same copy and `chmod`, but only the script reloads the running applet. Have the Makefile target call the script. |

## Laws of UX

A pass over the interface against [lawsofux.com](https://lawsofux.com/), naming
the law each finding sits under. Nothing here is a malfunction; every row is
about what the interface asks of the person reading it.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-55 | medium | M | **Miller's Law, Chunking, Law of Common Region.** With *Include disk, network and board sensors* on, the Sensors submenu is 19 rows in one undifferentiated column — measured on this machine. They are already sorted by kind and each kind already carries a label that nothing renders (`KINDS` in [lib/sensors.js](cinnamon-powertoys@geraldo-netto/lib/sensors.js)), so a heading per kind is a few lines and turns one list of nineteen into four lists of two to seven. It also gives `kindLabel()` the caller PT-49 could not find for it. |
| PT-56 | medium | S | **Law of Proximity, Law of Common Region.** The three power profiles sit directly under the summary line with nothing saying what they are, because `SelectorGroup` is built with an empty title. The governor and energy-preference lists inside the processor submenu are the same widget with a heading. Same control, two conventions, and the unlabelled one is the applet's headline feature. |
| PT-57 | medium | S | **Serial Position Effect.** The last row of the menu is the one people remember and reach for, and it holds `Power Toys 1.0.0`, which cannot be acted on. The two things that can — *System power settings* and *Configure Power Toys* — sit above it. Put the version in the settings window or on the configure row and give the end of the menu back to an action. |
| PT-58 | medium | S | **Peak-End Rule.** Changing a governor, an energy preference, the boost switch or the charge limit reports failures and says nothing at all on success. So the memorable end of the interaction is a password prompt followed by silence, and the only confirmation is noticing the menu now reads differently. |
| PT-59 | medium | XS | **Postel's Law, feedback.** A *Preferred CPU sensor* hint that matches nothing falls through to automatic selection without a word. The person who typed it has no way to tell whether it took effect. Mark the chosen sensor in the menu, or say in the settings window that the hint matched nothing. |
| PT-60 | medium | XS | **Cognitive Load.** *Scaling driver: amd-pstate-epp (active)* is kernel vocabulary in a menu aimed at anyone. Governors and energy preferences already go through label tables in [lib/format.js](cinnamon-powertoys@geraldo-netto/lib/format.js); the driver row does not. |
| PT-61 | medium | S | **Jakob's Law.** The applet this one can replace, `power@cinnamon.org`, changes screen brightness when the wheel is used over it and toggles the keyboard backlight on a middle click. Here the wheel does nothing unless *Mouse wheel over the applet* is changed from its default, and middle click does nothing at all. Someone switching applets silently loses two gestures they already have. |
| PT-62 | medium | S | **Paradox of the Active User.** Nobody reads the README first. On a desktop the applet is now an icon with no text beside it, and the two richest parts of the menu are behind submenus that are folded by default. There is nothing on first run that says what it can do. |
| PT-63 | low | XS | **Von Restorff Effect.** Bold now marks three different things: the summary line, the group headings, and a warning. The one that is supposed to stand out is the one competing with the other two. |
| PT-64 | low | XS | **Law of Uniform Connectedness.** Four groups in the menu, three conventions: no separator between the summary and the profiles, a separator above the devices that appears only when there are any, and a fixed one above the submenus. |

