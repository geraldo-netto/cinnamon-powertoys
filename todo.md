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
| PT-157 | low | S | Which profile backend answers is decided from one backend's news only. [`_chooseProfileBackend`](cinnamon-powertoys@geraldo-netto/applet.js#L2396) runs in the constructor and again from the profiles client's own onChanged ([applet.js:1863](cinnamon-powertoys@geraldo-netto/applet.js#L1863)) — which is the daemon appearing or vanishing, and nothing else. So on a machine with no power-profiles-daemon, which is where the firmware backend matters, that callback never fires again and the choice made in the constructor stands for the session: a vendor module loaded after login, or an applet that came up before the driver settled, leaves `/sys/firmware/acpi/platform_profile` there and unread until the applet is reloaded. The sensors have [`refresh`](cinnamon-powertoys@geraldo-netto/lib/sensors.js#L655) for the same problem and it costs a directory listing; this costs one `IO.exists` and one `readWords`, and only while there is no daemon. Asking it again where the menu is opened would close it without putting anything on the poll. |

## Backends and lifecycle

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-160 | low | XS | [`_runHelper`](cinnamon-powertoys@geraldo-netto/applet.js#L2852) returns without a word when the privileged controls are off. That is PT-149's contract — every call answers exactly once — arrived at from the applet's side: [`_runHelperQuietly`](cinnamon-powertoys@geraldo-netto/applet.js#L2741) three lines above answers `{ applied: false, error: … }` for the same condition, and it is the reason the platform profile client can report a refusal at all. Nothing waits on the silent one today, because the two callers that would ([`CpuControl`](cinnamon-powertoys@geraldo-netto/lib/cpu.js#L94) and [`ChargeControl.setLimit`](cinnamon-powertoys@geraldo-netto/lib/power-supply.js#L80)) are handed no `onDone` by the menu — which is the same "today's callers survive it" that PT-149 was closed rather than left. |
| PT-163 | low | S | The charge limit is discovered once and never again. [`discoverChargeControl`](cinnamon-powertoys@geraldo-netto/lib/power-supply.js#L90) walks `/sys/class/power_supply` in the applet's constructor ([applet.js:1839](cinnamon-powertoys@geraldo-netto/applet.js#L1839)) and its answer decides two things for the session: whether the menu is built with a charge limit group at all ([applet.js:2226](cinnamon-powertoys@geraldo-netto/applet.js#L2226)), and which batteries a write reaches. A battery that appears afterwards — a dock, a bay battery, a driver that loads late — has a `charge_control_end_threshold` nobody reads and no control to write it, while the sensors beside it are rediscovered every minute by design. The read half is already live on purpose (the comment over `ChargeControl` says the firmware and vendor tools move these); it is the set of batteries that is frozen. |

## Guards asked of the wrong thing

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-156 | low | S | [`_canProbeMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2118) says of itself that neither of its two questions is about the moment — "they are about the machine" — and the second one is entirely about the moment. `screen.available` is lowered by [`BacklightControl.refresh`](cinnamon-powertoys@geraldo-netto/lib/backlight.js#L129) on any failed `GetPercentage`, and the menu re-asks every backlight each time it opens, so cinnamon-settings-daemon being restarted is enough to make a laptop with a perfectly good kernel backlight answer true here. What follows is not a wasted tick: [`_probeMonitors`](cinnamon-powertoys@geraldo-netto/applet.js#L2137) calls [`redetect`](cinnamon-powertoys@geraldo-netto/lib/ddc.js#L557), which *starts* a control that was never started, so the applet begins spawning ddcutil across the I2C buses of a machine that was deliberately kept off them — and if a monitor answers, it grows sliders the menu had no business offering. Either ask the daemon rather than the last answer from it, or keep the machine's half of the question where `start()` and `stop()` are already decided, in [`_considerMonitorBacklight`](cinnamon-powertoys@geraldo-netto/applet.js#L2019), and let this one ask only about the moment it is honestly about. |

## Cost per poll

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-158 | low | S | UPower is described three times over on every poll. [`read`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L403) calls [`snapshot`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L360), which walks `_devices` and runs [`_describe`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L328) on every one; then [`lineDevices`](cinnamon-powertoys@geraldo-netto/lib/upower.js#L367) walks the same map again and describes the line power adapters a second time; then `_primaryDevice` describes the display device. Each `_describe` is nineteen property reads, and a property on a GDBusProxy is a cached-variant lookup and an unpack apiece — so a laptop with a battery, a charger, a composite and three bluetooth peripherals pays a few hundred variant unpacks per poll for a list it is about to build in one place anyway. This is the shape of the double unpack already closed in lib/profiles.js, which is what `snapshot()` there exists for. One walk of `_devices` can answer all three questions; the display device is the only proxy that is not in it. |

## The file no gate can see

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-161 | high | M | [applet.js](cinnamon-powertoys@geraldo-netto/applet.js) is 3117 lines against 5308 in the libraries — 37% of the JavaScript — and neither gate reaches a line of it. [`tools/mutate.js`](tools/mutate.js#L199) builds its file list from `lib/` alone, and the coverage run measures the copies it writes of those same libraries, so "410 functions, every one at 80% or better" and "84% of mutants caught" are both statements about the other 63%. The eleventh pass made this argument once and `lib/alerts.js` and `lib/reading.js` came out of it; what is left in there that is not wiring is the same kind of thing they were — a function of a reading and the options in force, with no widget in it — and it is where PT-153 has been sitting unseen. Split as below, each part a move plus the cases that could not have been written before it. |
| PT-161a | high | S | The sensor list model: [`_entryKey`](cinnamon-powertoys@geraldo-netto/applet.js#L1569), `_rowLabel`, `_temperatureEntry`, `_fanEntry`, `_powerEntry`, [`_sensorEntries`](cinnamon-powertoys@geraldo-netto/applet.js#L1616), [`_withHeadings`](cinnamon-powertoys@geraldo-netto/applet.js#L1637) and [`_cpuReadingRows`](cinnamon-powertoys@geraldo-netto/applet.js#L1681). Between them they decide which readings are shown, where the headings fall, and which chip the processor's own rows are filed under when it reports no temperature at all — that last one is a branch reached only on hardware most machines are not, and nothing can reach it today. None of them touches a menu: they take a reading and hand back entries. |
| PT-161b | medium | S | What the panel says: [`_iconSource`](cinnamon-powertoys@geraldo-netto/applet.js#L281), [`_labelText`](cinnamon-powertoys@geraldo-netto/applet.js#L314), [`_profileNeedsSpelling`](cinnamon-powertoys@geraldo-netto/applet.js#L338) and [`_tooltipText`](cinnamon-powertoys@geraldo-netto/applet.js#L385). The tooltip is six lines with a rule for each and a peripheral list that counts what it drops; the label is three parts joined by a dot with a rule about when the profile is worth spelling out at all. Both are strings from a reading, and `PanelPresenter` keeps only the four calls that put one on the panel. |
| PT-161c | medium | S | The two settings decisions: [`_panelText`](cinnamon-powertoys@geraldo-netto/applet.js#L2605) and [`_migratePanelText`](cinnamon-powertoys@geraldo-netto/applet.js#L2634), which is a one-way upgrade path over three old switches that runs exactly once per install and can never be run again to see whether it was right. It reads four settings and writes one; given those four as arguments it is a pure choice between four names. |
