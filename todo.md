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
| PT-17 | medium | S | Scroll-to-change-profile has no debounce and no feedback ([applet.js:1144](cinnamon-powertoys@geraldo-netto/applet.js#L1144)). One flick of the wheel sends several D-Bus property writes. Coalesce on a short timeout and show the resulting profile, the way `_cycleProfile()` does. |
| PT-18 | low | M | `_updateMenu()` runs on every poll even when the menu is closed ([applet.js:780](cinnamon-powertoys@geraldo-netto/applet.js#L780)), rebuilding label text for rows nobody can see. Update the panel always, the menu only while `this.menu.isOpen`, plus once on open. The rebuild paths now share KeyedList, so this is one guard in `_updateMenu()` plus a sync on open. It is also what turns PT-19's lazy frequency into a saving in the default configuration, where the CPU section still asks for the value on every poll. |
| PT-21 | medium | M | No `po/` directory and no `.pot`, although every string goes through `_()` and `make pot` exists. Without the template neither the applet strings nor the settings-schema descriptions can be translated, and nothing in the project compiles or installs a translation once one exists. |
| PT-21a | medium | XS | Run `cinnamon-xlet-makepot`, commit `po/cinnamon-powertoys@geraldo-netto.pot`, and document how to start a locale from it. |
| PT-21b | medium | S | Nothing turns a `.po` into an installed `.mo`: both `install.sh` and `make install` copy the applet directory only, while the applet binds its text domain to `~/.local/share/locale` ([applet.js:33](cinnamon-powertoys@geraldo-netto/applet.js#L33)). Add `msgfmt` to the install path so a translation actually takes effect. |
| PT-23 | medium | S | No CI. A small workflow running `sh -n` on the helper, JSON validation on the two schema files and the `cjs` parse check on the five JavaScript files would catch every class of error that showed up during development. |
| PT-27 | medium | M | No tests. The throwaway smoke script used during development (sensor discovery, CPU control read-out, profile client, UPower snapshot) covers the risky parts and runs under plain `cjs`; move it into `tests/` and wire it to `make check`. |
| PT-27b | low | XS | Cases for `lib/format.js`, which is pure: units, thresholds, durations, the UPower enum names and the profile and governor label tables. No system access needed, so these can run anywhere. |
| PT-27d | low | XS | A smoke case for the UPower monitor and the profile client against the live daemons, skipped rather than failed when they are not on the bus, so CI without a system bus stays green. |
| PT-32 | medium | M | One of the three clusters left in the applet class that are more than wiring. The two profile backends are stitched together rather than made interchangeable. `PowerProfilesClient` and `Sysfs.platformProfile()` have different shapes, so `_collect()` unions them behind a `viaSysfs` flag ([applet.js:481-503](cinnamon-powertoys@geraldo-netto/applet.js#L481-L503)) and `_setProfile()` re-reads that flag to pick the write path ([applet.js:1017-1025](cinnamon-powertoys@geraldo-netto/applet.js#L1017-L1025)). |
| PT-32a | medium | S | Add a `PlatformProfileClient` alongside `PowerProfilesClient` with the same `available` / `active` / `list` / `setProfile()` surface, writing through the pkexec helper and reading the ACPI nodes. On its own this changes no behaviour. |
| PT-32b | medium | XS | Choose the backend once — at startup and whenever the daemon appears or vanishes — and the `viaSysfs` flag, the union in `_collect()` and the branch in `_setProfile()` all go away. |
| PT-33 | medium | S | One of the three clusters left in the applet class that are more than wiring. `DeviceRow` and the menu depend on each other. The row is handed the whole applet ([applet.js:101](cinnamon-powertoys@geraldo-netto/applet.js#L101)) and calls back into `describeDevice()`, `isDraining()` and `lowThresholdFor()` while updating ([applet.js:148-152](cinnamon-powertoys@geraldo-netto/applet.js#L148-L152)), so the row cannot be built or tested without a live applet. Compute a small view model (title, icon, details, warning) and pass that. Mechanical once PT-34 has moved the three methods out, which is why this is no longer sized as its own project. |
| PT-37 | medium | S | One of the three clusters left in the applet class that are more than wiring. `_runHelper()` does five jobs — the settings gate, the existence check, the executable-bit repair, the spawn, and the exit-code-to-notification policy ([applet.js:1085-1120](cinnamon-powertoys@geraldo-netto/applet.js#L1085-L1120)) — and returns silently when privileged controls are off, so a caller whose switch is visible cannot tell the difference between applied and ignored. Extract a `PrivilegedHelper` class and leave the gate to the caller. |
| PT-51 | medium | S | The 21 bound settings arrive as loose `this.<camelCase>` properties whose names are produced by a string transform ([applet.js:224-247](cinnamon-powertoys@geraldo-netto/applet.js#L224-L247)), so nothing lists them, nothing checks them, and a typo in the key array turns into `undefined` at the point of use instead of an error at bind time. The single `_onSettingsChanged()` callback then invalidates every cached key for any change, so picking Fahrenheit rebuilds the device rows. |
| PT-52 | low | XS | Two install paths that have already diverged: `make install` ([Makefile:15-20](Makefile#L15-L20)) and [install.sh](install.sh) perform the same copy and `chmod`, but only the script reloads the running applet. Have the Makefile target call the script. |
