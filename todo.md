# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Sixth pass

Every source file read again after the asynchronous poll, the three-panel menu
and the typographic changes went in. Build output, caches and `.git` skipped;
the project has no generated files. Most of what is below was introduced by
that work rather than found surviving from before it.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-83 | medium | XS | *Control external monitor brightness* only takes effect on the next reload. `DdcBacklight.start()` has one caller, `_onScreenBacklightKnown()`, which runs once when the settings daemon answers; the setting itself binds to the default redraw handler, so switching it on later probes nothing and the slider never appears. |
| PT-84 | medium | S | The profile backend is asked five separate times per reading. `_collectProfile()` reads `available`, `busName`, `active`, `profiles`, `degraded` and `holds` as six getters, and on a firmware-profile machine each one re-reads `/sys/firmware/acpi/platform_profile` and its choices — about eight synchronous opens for one reading. On the daemon path it measured 231 µs of a 946 µs collection. One read per collection would do. |
| PT-86 | low | XS | `install.sh` says "Reloaded the running applet, no restart needed", which is not true of `stylesheet.css`. Cinnamon keeps the old stylesheet loaded across an xlet reload, so a rule that was changed or deleted goes on applying until the theme is reloaded — verified while working on PT-63, where deleted `font-weight: bold` rules kept taking effect. Either reload the theme too or say which changes need more than a reload. |
| PT-87 | low | XS | `KeyedList.sync()` decides whether to rebuild by joining the entry keys with commas, so two different sets whose joined form is identical read as unchanged and the rows are never rebuilt. No key contains a comma today, which is the only reason this is not a bug; it is a trap for whoever adds the next one. |
| PT-88 | low | XS | `data.temperatureSensorId` is computed on every reading and read nowhere. |
| PT-89 | low | XS | `Sensors.bySensorOrder` has no caller outside the case that tests it — the menu sorts with `MenuPresenter._bySensorGroup` instead. Either the menu should use it or it should go. |
| PT-90 | low | XS | `PlatformProfileClient` is the one backend `on_applet_removed_from_panel` does not destroy. Its `destroy()` is empty, so nothing leaks today; the asymmetry is what will be wrong the moment it holds anything. |
| PT-91 | low | XS | `runCommand()` in [lib/ddc.js](cinnamon-powertoys@geraldo-netto/lib/ddc.js) leaves its eight second timeout armed after the process has answered. It fires, finds the call already finished and removes itself, so the cost is one dangling timer per `ddcutil` call rather than a bug. |
| PT-92 | low | XS | `DdcBacklight.refresh()` does not check `_busy` the way `setPercentage()` does, so opening the menu part way through a slider drag spawns a read against a monitor that is already being written to. |

## Documentation drift

The applet changed shape; the things that describe it did not.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-93 | medium | S | [docs/menu.png](docs/menu.png) is a picture of a menu that no longer exists: one column, *Processor* and *Sensors* as collapsed submenus, no brightness sliders, no panel titles, no version on the configure row. It is the README's only image, directly under a paragraph describing three panels side by side. |
| PT-94 | low | XS | The README's compatibility argument lists `PopupSubMenuMenuItem`, which the applet stopped using when the panels became columns, and does not mention what it uses now: a `PopupMenuSection` laid out horizontally, `Gio.File.load_contents_async`, and `Gtk.IconTheme`'s `changed` signal. The "Cinnamon 5.4 or newer" claim has not been re-checked against any of those. |
| PT-95 | low | XS | The README's Layout tree omits `lib/device.js`, `lib/log.js`, `lib/gettext.js` and `lib/privileged.js`, and shows neither `tools/` nor `tests/`. |
| PT-96 | low | XS | `tests/cases/loading.js` says it lists "everything applet.js names on a library" and no longer does. `format.profileIconIsUnambiguous`, `format.forgetIcons` and `sensors.kindRank` are named and unlisted; `sensors.bySensorOrder` is listed and not named; and what one library uses from another — `io.readStringsAsync`, `io.toNumber` — is outside its scope entirely. The guard against a rename has holes exactly where the newest code is. |
| PT-97 | low | XS | `SelectorGroup`'s comment still describes "an optional bold title". Nothing in the menu is bold except a warning since PT-63. |
