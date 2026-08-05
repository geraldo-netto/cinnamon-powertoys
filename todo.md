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

| id | category | status | effort | severity | description |
| --- | --- | --- | --- | --- | --- |
| PT-195 | Installation | open | M | medium | Applet installation is rolled back as one transaction, but `tools/install-translations.sh` publishes each catalogue immediately and continues after compilation failures. A later failure restores the old applet while leaving any earlier languages updated, creating a mixed-version installation despite `install.sh` treating translations as part of the same operation. Compile and stage every catalogue first, then publish them atomically or restore the prior catalogues when the parent install fails. |
| PT-197 | Documentation | open | XS | low | README says monitor detection repeats once per second while either the menu is open or the pointer rests on the icon, but `_watchMonitors()` now performs only one warm-up probe for a tooltip hover and `_considerProbing()` reserves recurring probes for an open menu. Update the DDC behavior description so users are not promised recurring hover probes that no longer occur. |
| PT-198 | Internationalization | open | S | low | `Format.duration()` hardcodes English-style `h` and `m` suffixes and hour-before-minute ordering, then inserts that result beside translated remaining-time text. Locales that use different abbreviations or ordering therefore cannot translate a visible part of battery status. Format durations through translatable templates, including the hours-only/minutes-only variants needed to preserve the compact display. |
