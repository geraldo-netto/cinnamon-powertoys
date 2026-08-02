# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Ninth pass — the whole tree, read again

Every tracked file except the fixtures and the two screenshots: `applet.js`,
all sixteen libraries, the helper, the schema, the stylesheet, the Makefile,
`install.sh`, the workflow, the polkit action, the udev rule, the tests and the
README. Nothing generated and nothing under a cache was read. The suite is at
188 passing and the tree is clean, so none of what follows is a regression —
these are things the code has been doing all along.

## Behaviour

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-114 | medium | XS | The wheel and the profile hotkey step from the profile the machine has, not from the one already asked for. [`_stepProfile`](cinnamon-powertoys@geraldo-netto/applet.js#L2829) reads `state.active`, which comes from the last completed reading, so while `_pendingProfile` is set a second step computes the same target and [`_setProfile`](cinnamon-powertoys@geraldo-netto/applet.js#L2746) drops it as a duplicate. Under power-profiles-daemon that window is milliseconds; on the ACPI platform profile it is however long the password dialog is on screen, and for all of it the wheel and the hotkey do nothing. Worse, `_stepProfile` announces whether or not `_setProfile` accepted, so the hotkey reports a change that is not happening. Step from `this._pendingProfile \|\| state.active`, and only notify when the call was taken. |
| PT-118 | medium | S | [`lib/bluez.js`](cinnamon-powertoys@geraldo-netto/lib/bluez.js#L184) subscribes to `PropertiesChanged` on the whole of `org.bluez` with no path and no `arg0` filter, and every one of those signals costs a full `GetManagedObjects` round trip. A `MediaTransport1` volume change while music is playing, or `Device1.RSSI` while the adapter is discovering, each fire several times a second and none of them can alter a battery percentage. Filter on the two interfaces this module actually parses, or gather a burst into one idle refresh. |
| PT-122 | low | XS | The charge limit is read from one battery and written to all of them. [`discoverChargeControl`](cinnamon-powertoys@geraldo-netto/lib/power-supply.js#L56) returns the first battery carrying `charge_control_end_threshold` and `limit` reads that one node, while the helper's [`set_charge_threshold`](cinnamon-powertoys@geraldo-netto/powertoys-helper#L153) loops over every battery that has it. On a ThinkPad with two batteries the menu shows BAT0's number for both, and where a vendor tool has set them apart it shows one and hides the other without saying so. Read them all and show the disagreement, or narrow the helper to match the reader. |

## Presentation

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-115 | medium | XS | Two heading rules in the stylesheet do nothing, for the reason `.powertoys-group-spaced` was already fixed for. [`.powertoys-group-title`](cinnamon-powertoys@geraldo-netto/stylesheet.css#L127) and [`.powertoys-subgroup-title`](cinnamon-powertoys@geraldo-netto/stylesheet.css#L150) are one class each; the theme sets padding on `.popup-menu-item`, which is also one class and is loaded after this file, so it ties on specificity and wins on order. Mint-Y-Dark-Aqua, the theme in use here, says `padding: .4em 1.75em` — so the 2px under a group heading is really the theme's, and neither `padding-top` has ever applied. Give both the two-class form the spaced rule already uses, then re-measure rather than assuming the numbers were right when they were written. |

## Code and tests

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-116 | low | XS | Four doc blocks describe the function two below them, each one left behind when something was inserted above it. In `applet.js`: the comment on the panel's power figure sits above [`shownProfile`](cinnamon-powertoys@geraldo-netto/applet.js#L233) and belongs to `panelPowerText`; the comment on a key that binds to nothing sits above [`_introduce`](cinnamon-powertoys@geraldo-netto/applet.js#L2113) and belongs to `_reportUnboundSettings`; the comment on Gio prefixing a remote error sits above [`_runHelperQuietly`](cinnamon-powertoys@geraldo-netto/applet.js#L2783) and belongs to `_notifyProfileError`. In [`lib/format.js`](cinnamon-powertoys@geraldo-netto/lib/format.js#L260) the comment on the shipped profile icons sits above `profileIconIsUnambiguous` and belongs to `profileIconName` — that one is fallout from reverting PT-111. Move each down; `_reportUnboundSettings` and `_notifyProfileError` then stop being the only two methods in the file with nothing said about them. |
| PT-119 | low | S | [`lib/backlight.js`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L78) and [`lib/profiles.js`](cinnamon-powertoys@geraldo-netto/lib/profiles.js#L85) build their D-Bus proxies themselves, and they are the only two backends that do. `ddc.js` takes a `run`, `bluez.js` a `call`, `privileged.js` a `spawn`, `cpu.js` and `power-supply.js` a runner plus the IO root — which is why each of those has real cases and these two have "it loads" and nothing else. `profiles.js` is reached by [`tests/cases/live.js`](tests/cases/live.js) where there is a system bus, which CI has not got, so on the runner it is never exercised at all. Give both the same seam the rest already have. |

## Packaging and supply chain

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-120 | low | XS | The workflow downloads `cinnamon-xlet-makepot` from a raw GitHub URL, `chmod +x` it and runs it as root, pinned to the tag [`6.6.9`](.github/workflows/check.yml#L70). A tag is a moving reference; pin the commit, or check a known SHA-256 before making it executable. While there, the job declares no `permissions:` block, so it takes whatever the repository default is — `contents: read` is the whole of what it needs. |
| PT-121 | low | XS | The translation template ships with the extractor's placeholders: `SOME DESCRIPTIVE TITLE`, `PACKAGE VERSION`, `FIRST AUTHOR <EMAIL@ADDRESS>` and a `#, fuzzy` on the header itself. A translator's first sight of the project is a file that names neither it nor where to send the result. The [`pot` target](Makefile#L126) already strips one header line with `sed` to keep the output reproducible; stamp the identity in the same place, so the template stays a function of the sources and the workflow's diff check goes on passing. |

## Documentation drift

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-123 | low | XS | The *Requirements* list in [README.md](README.md#L336) names `PopupIconMenuItem` and `Util.spawnCommandLine` among the Cinnamon calls this applet leans on and checks against the 5.4 sources. Neither appears in the source any more — both went with the *Configure Power Toys* row. A list of what the code touches is only worth keeping if it is what the code touches. |
