# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Review scope: runtime source, configuration, install/uninstall paths, policy,
udev rules, styles, icons and documentation. Cache, build output, generated
artifacts, tests and test-only tooling were excluded as requested.

Review categories: functional correctness; reliability, lifecycle and
concurrency; security and permissions; performance and resource use; UX and
accessibility; internationalization; compatibility and maintainability;
installation and operations; documentation and assets. Each item names its
primary category even where the impact crosses categories.

## High

- [ ] **PT-162 · Correctness · M — Coarse battery levels leak through as fake percentages and numeric warnings.** `lib/format.js:164-166` defines the precise-reading rule, but `lib/alerts.js:88-115`, `lib/device.js:138-141` and `lib/panel-text.js:126-163,195-203` compare or format `Percentage` directly. UPower publishes `0` for an unset percentage and requires `BatteryLevel` to take precedence, so a coarse “Low” device can be shown/notified as `0%`. Centralize the effective battery reading, format coarse labels everywhere, and give LOW/CRITICAL levels non-numeric alert semantics. ([UPower device contract](https://upower.freedesktop.org/docs/Device.html))

- [ ] **PT-163 · Correctness · M — CPU choices and writes assume every cpufreq policy matches the first one.** `lib/cpu.js:50-58,93-108` exposes the first policy's governors/EPP and current value, while `powertoys-helper:90-123` validates only that policy before writing every policy sequentially. These lists are per-policy, so heterogeneous policies can leave the CPU partially changed before the helper fails. Compute the intersection and current agreement across all target policies, preflight every target before writing, and roll back already-written policies if a later write fails. ([kernel CPUFreq contract](https://www.kernel.org/doc/html/latest/admin-guide/pm/cpufreq.html))

- [ ] **PT-177 · Correctness · M — Charge-threshold writes can silently leave batteries in a partially changed state.** `powertoys-helper:167-208` lowers each battery's start threshold before writing its end threshold, ignores a failed start write, and continues across batteries after an end write fails. A refusal on a later node therefore leaves earlier batteries changed and can leave a start threshold lowered even when its matching end threshold was not accepted. Enumerate and preflight every node first, capture the original start/end values, apply the set transactionally, and roll back all completed writes on failure while reporting whether restoration succeeded.

## Medium

- [ ] **PT-164 · Performance · S — “All sensors” polls hidden disk/network/board sensors continuously.** `applet.js:2208-2215` makes `show-all-sensors` the read filter without considering `show-sensors` or whether the menu is open, and `lib/sensors.js:773-803` documents that these reads can wake drives and dominate every poll. Read non-primary sensors only while their visible menu group is open, while retaining explicitly hinted sensors needed by panel readings and alerts.

- [ ] **PT-165 · UX · S — Already-selected controls still execute writes and authentication.** `applet.js:448-458,649-680` leaves selected selector rows and profile segments actionable, and `applet.js:2527-2533,2689-2708` does not reject the machine's current value. Clicking the active ACPI profile, governor, EPP or charge limit closes the menu and can open pkexec merely to rewrite the same value. Make active choices insensitive or no-op at the shared control/action boundary.

- [ ] **PT-166 · Reliability · M — UPower availability outlives the service owner and turns “unknown” into AC power.** `lib/upower.js:184-194,217-237,366-368` never watches `org.freedesktop.UPower` ownership; after the well-known name vanishes, GLib flushes proxy properties but `available` remains true and missing `OnBattery` becomes false. `lib/panel-text.js:145-154` therefore reports AC power during daemon downtime, and startup failure is never retried. Observe `g-name-owner`, clear availability/devices on vanish, and rebuild/re-enumerate on appearance. ([GDBusProxy lifecycle](https://docs.gtk.org/gio/class.DBusProxy.html))

- [ ] **PT-167 · Correctness · S — Charge-limit reads cannot distinguish disagreement from unreadable batteries.** `lib/power-supply.js:50-73` collapses partial read failure and genuinely different thresholds into `limit: null`, sometimes with `divided: false`; `applet.js:1176-1179,1491-1498` can then show an editable list with no selected value or a “sets both” note while the control itself is hidden, including on systems with more than two batteries. Return an explicit agreed/divided/incomplete state, disable or explain incomplete readings, show the note only alongside an actionable control, and use “all batteries” or a count-aware message.

- [ ] **PT-168 · Operations · M — Installation deletes the working applet before its replacement exists.** `install.sh:19-22` removes the live target and then copies into it, so a full disk, interrupted copy or unreadable source leaves the previous working install replaced by a partial tree. Copy and validate a temporary sibling first, then atomically swap it into place with rollback/cleanup.

- [ ] **PT-169 · Reliability · S — A transient startup screen-backlight failure permanently enables DDC probing.** `lib/backlight.js:110-145` has no service-owner retry after proxy initialization or the first `GetPercentage` fails, `applet.js:1762-1790` latches that first answer into `_hasKernelBacklight`, and later successful refreshes only sync the sliders at `applet.js:1945-1947`. Retry or reconnect the screen backend, promote the hardware decision after any successful refresh, and stop/reconcile DDC probing when the kernel backlight recovers.

- [ ] **PT-170 · Reliability · M — DDC detection keeps stale monitors on errors but drops known monitors on one empty success.** `lib/ddc.js:633-681` preserves the old topology forever for every nonzero `ddcutil detect`, including permanent tool/permission failures, yet immediately destroys it when one successful probe parses no displays. Distinguish probe failure from a valid empty topology and apply a bounded confirmed-missing/failure grace so transient sleep does not flicker sliders and permanent failure does not leave stale ones.

- [ ] **PT-171 · UX · S — Smooth touchpad/high-resolution scroll events do nothing.** `applet.js:842-848,2766-2770` handles only discrete UP/DOWN directions, so `Clutter.ScrollDirection.SMOOTH` is propagated or ignored for sliders and panel actions. Read `event.get_scroll_delta()` for smooth events and accumulate fractional deltas into the existing settled step path. ([Clutter smooth-scroll API](https://gnome.pages.gitlab.gnome.org/mutter/clutter/method.Event.get_scroll_delta.html))

- [ ] **PT-172 · Correctness · S — The critical-battery setting can display a value the alert policy never uses.** `settings-schema.json:170-189` permits low and critical thresholds to cross, while `lib/alerts.js:52-55` silently clamps critical to `low - 1` only at runtime. Normalize the paired stored setting when either changes, or show the effective critical value, so configuration and notification behavior agree.

- [ ] **PT-173 · Internationalization · S — Installed translations for removed languages are never pruned.** `tools/install-translations.sh:34-51` compiles current `.po` files over existing catalogues but removes none belonging to languages that were deleted or renamed, so obsolete `$UUID.mo` files survive every upgrade. Remove only this domain's old catalogues before a successful install, or maintain an installed-language manifest without disturbing other applications.

- [ ] **PT-174 · Documentation · M — The README promises lid-closed DDC behavior that the implementation forbids.** `README.md:53-64` says a laptop with its lid shut gets external-monitor sliders, while `settings-schema.json:114-118` and `applet.js:1811-1816,1915-1916` disable DDC on every machine that has a built-in backlight, regardless of lid/output state. Either detect the active output/lid topology and support the promise, or remove the promise and document the actual limitation consistently.

- [ ] **PT-178 · Correctness · S — A DDC slider keeps the previous monitor's name when hardware changes on the same bus.** `lib/ddc.js:263-270` deliberately adopts a newly detected display's number and name while preserving its bus ID, but `applet.js:1036-1043,1279-1282` keys the row by that ID and only calls `row.sync()`. `BacklightSlider` therefore retains the old label and tooltip until the row is rebuilt for another reason. Add a row update/adopt method that refreshes the control and name, or include display identity changes in the list's rebuild signature.

- [ ] **PT-179 · Performance · S — Hovering the panel icon probes every DDC monitor once per second without updating the tooltip.** `applet.js:1565-1574` notes that the tooltip names no monitor, but the tooltip reason still holds the recurring probe timer in `applet.js:1862-1899`. A prolonged or accidental hover repeatedly spawns `ddcutil` and wakes monitor buses solely to prepare a future menu open. Reserve recurring probes for an open menu and, if hover prefetch remains, make it one debounced probe per hover.

- [ ] **PT-180 · Compatibility · M — The profile selector cannot fit firmware that exposes many or long profile names.** `lib/profiles.js:42-58` handles firmware lists that can contain six profiles, including `balanced-performance`, while `applet.js:643-663` forces every segment into one horizontal row whose minimum is its full natural width. That can push the menu beyond the usable screen width. Wrap the control into an adaptive grid or fall back to a vertical selector above a measured width/count threshold while preserving logical keyboard order.

- [ ] **PT-181 · Accessibility · M — Custom profile and brightness controls expose their state only visually.** `applet.js:594-680` represents the active profile with a CSS class on plain buttons but does not expose a radio/toggle role or checked state; `applet.js:761-837` adds a label and percentage around Cinnamon's generic menu-item slider without setting an accessible name, slider role, or value metadata. Add explicit roles/names, checked state for profile choices, and changing value metadata/notifications for brightness while retaining the existing keyboard behavior.

- [ ] **PT-183 · Lifecycle · S — An in-flight daemon profile callback survives applet teardown.** `lib/profiles.js:175-187,381-410` starts an uncancellable D-Bus `Set` call while `destroy()` only disconnects the proxy and name watches; `applet.js:2527-2546` then handles the late callback without a destroyed/generation guard and can notify or schedule work for a removed applet. Give the call a cancellable or generation token and ignore/settle stale completions after destruction.

- [ ] **PT-185 · Security · M — RAPL uninstall overwrites permissions owned by other system policy.** `Makefile:119-127` removes this applet's udev rule and then forcibly sets every matching counter to `root:root` mode `0400`. If a distribution, administrator or another remaining udev rule assigned a different group/mode, uninstall clobbers that policy instead of merely undoing this applet's rule. Reset to the conservative kernel permissions, then retrigger the subsystem after removing this rule so remaining rules get the final say, or preserve and restore prior state.

- [ ] **PT-188 · Internationalization · M — Privileged-control failures are displayed as untranslated helper stderr.** `powertoys-helper:24-40,90-208` emits English prose, `lib/privileged.js:55-59` extracts it verbatim, and `applet.js:2737-2739` sends it directly to `Main.notifyError`. Common failures therefore bypass the applet's translation catalog. Return stable structured error codes, map those to translated user-facing messages in the applet, and keep the raw diagnostic in the log.

## Low

- [ ] **PT-175 · Reliability · S — Power-profile fallback discovery can strand an already-present alternate backend.** `lib/profiles.js:210-222` ignores appearances while a proxy exists, then disconnects on the selected name's disappearance without calling `_connect()`. If the alternate supported name was already owned, no later event restarts discovery and the applet falls back until reload. Re-run backend selection after the active name vanishes.

- [ ] **PT-176 · Reliability · XS — Panel-text migration marks itself complete before applying the migrated value.** `applet.js:2470-2479` writes `panel-text-migrated` first, so an exception or interruption before the second settings write permanently skips migration. Write the derived `panel-text` first and set the completion marker last.

- [ ] **PT-182 · UX · S — Shortcut conflicts fail silently while the applet records the hotkey as registered.** `applet.js:2877-2888` ignores the boolean returned by `Main.keybindingManager.addHotKey()` and appends the name to `_hotkeyIds` even when Cinnamon rejects a conflicting accelerator. The setting can therefore show a shortcut that never fires and offers no explanation. Check the return value, track only successful registrations, and surface a clear conflict diagnostic or revert the invalid setting.

- [ ] **PT-184 · Reliability · XS — The first-run notification is marked delivered before notification succeeds.** `applet.js:1725-1752` sets `introduced` before calling `Main.notify()`, even though that call is guarded because it has thrown during construction before. A failed notification is therefore never retried. Set the marker only after a successful notification and leave it clear in the catch path.

- [ ] **PT-186 · Documentation · XS — The sensor filter documentation omits package and battery sensors that remain visible.** `README.md:103-114` and `settings-schema.json:107-112` say disabling “all sensors” leaves only CPU/GPU readings, while `lib/sensors.js:36-50,70-73` also classifies package and battery sensors as primary. Document the complete primary set in both places, or change the filter to match the stated behavior.

- [ ] **PT-187 · Documentation · XS — RAPL instructions still say counters are discovered only at startup.** `README.md:250-258` and `Makefile:117` tell the user to reload the applet, but `lib/sensors.js:670-674` and `applet.js:2228-2232,2317-2323` rediscover topology every minute and whenever the menu opens. Update the instructions to say the row appears on the next menu open or periodic discovery, without a reload.

- [ ] **PT-189 · UX · XS — A positive remaining time below 30 seconds is rendered as “0m remaining”.** `lib/format.js:90-98` rounds seconds to minutes, and `lib/device.js:46-50` appends the status text, so a valid short estimate reads as zero time. Render a localized “less than a minute” form or clamp positive durations to at least one minute.
