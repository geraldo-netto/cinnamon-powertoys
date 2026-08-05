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
architecture and SOLID; coupling; wiring and integration; state management;
installation and operations; testing and quality assurance; documentation and
assets. Each item names its primary category even where the impact crosses
categories.

| id | category | status | effort | severity | description |
| --- | --- | --- | --- | --- | --- |
| PT-198 | Internationalization | open | S | low | `Format.duration()` hardcodes English-style `h` and `m` suffixes and hour-before-minute ordering, then inserts that result beside translated remaining-time text. Locales that use different abbreviations or ordering therefore cannot translate a visible part of battery status. Format durations through translatable templates, including the hours-only/minutes-only variants needed to preserve the compact display. |
| PT-221 | Internationalization | open | S | low | `Device.describe()` renders charge cycles as `device.cycles + " " + _("cycles")`, so a battery with one cycle is shown as “1 cycles” and languages cannot select their own plural forms. Add gettext plural support and format the complete singular/plural cycle phrase through it. |
| PT-222 | Internationalization | open | XS | low | `PanelText.powerStatusTooltip()` translates “Power source” and “Battery” but hardcodes the visible AC value as `"AC"`. Locales that use another abbreviation cannot translate the tooltip completely. Put the AC label through gettext with the rest of the power-source values. |
| PT-223 | Internationalization | open | S | low | `_updateProfiles()` exposes power-profiles-daemon's `PerformanceDegraded` machine token by only replacing hyphens with spaces. Values such as `lap-detected` remain lower-case English in an otherwise translated “Performance limited” row. Map known reasons to translatable user-facing labels and retain a readable fallback for future daemon values. |
| PT-299 | Installation and operations | open | S | low | `make uninstall-policy` removes the polkit action before the root-owned helper in separate recipe commands. If the second removal fails, the target reports failure but leaves an orphaned privileged executable that no installed action references. Coordinate removal and cleanup through the policy transition owner so a failed uninstall either restores the prior pair or reports a deliberately completed safe removal. |
| PT-300 | Reliability, lifecycle and concurrency | rejected/won't fix | S | low | During screenshot-assisted live verification Cinnamon emitted one unattributed `Clutter-WARNING`: an `StIcon` was removed from a `ClutterBox` that was not its parent. Power Toys does not directly remove either of its `StIcon` actors, five isolated menu open/close cycles plus delayed-callback time emitted no log line, and three applet reloads were also clean. With no stack, reproduction, or Power Toys attribution, a runtime change would be speculative; revisit only if an applet-only reproduction identifies the owning actor. |
