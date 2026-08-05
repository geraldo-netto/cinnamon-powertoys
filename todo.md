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
| PT-198 | Internationalization | open | S | low | `Format.duration()` hardcodes English-style `h` and `m` suffixes and hour-before-minute ordering, then inserts that result beside translated remaining-time text. Locales that use different abbreviations or ordering therefore cannot translate a visible part of battery status. Format durations through translatable templates, including the hours-only/minutes-only variants needed to preserve the compact display. |
| PT-210 | Architecture and coupling | open | M | medium | `PanelPresenter` reaches through Cinnamon's private `_applet_tooltip`, `_tooltip` and `_applet_icon` fields and replaces the tooltip instance's `show()` and `hide()` methods in place. A private-field or tooltip-lifecycle change can break panel updates across the declared Cinnamon versions, and there is no single fallback boundary. Isolate these accesses in a feature-detecting Cinnamon adapter with public-API fallbacks and explicit cleanup rather than coupling presentation logic directly to shell internals. |
| PT-211 | Documentation | open | XS | low | README's Requirements section says DDC is “Never probed on a machine that has a backlight of its own,” while the implemented PT-174 behavior, the Features section and the setting tooltip deliberately probe external monitors on such laptops when UPower reports the lid closed. Rewrite the requirement to describe the usable-built-in-screen condition so setup guidance matches runtime behavior. |
