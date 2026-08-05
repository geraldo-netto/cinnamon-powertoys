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
| PT-211 | Documentation | open | XS | low | README's Requirements section says DDC is “Never probed on a machine that has a backlight of its own,” while the implemented PT-174 behavior, the Features section and the setting tooltip deliberately probe external monitors on such laptops when UPower reports the lid closed. Rewrite the requirement to describe the usable-built-in-screen condition so setup guidance matches runtime behavior. |
| PT-221 | Internationalization | open | S | low | `Device.describe()` renders charge cycles as `device.cycles + " " + _("cycles")`, so a battery with one cycle is shown as “1 cycles” and languages cannot select their own plural forms. Add gettext plural support and format the complete singular/plural cycle phrase through it. |
| PT-222 | Internationalization | open | XS | low | `PanelText.powerStatusTooltip()` translates “Power source” and “Battery” but hardcodes the visible AC value as `"AC"`. Locales that use another abbreviation cannot translate the tooltip completely. Put the AC label through gettext with the rest of the power-source values. |
| PT-223 | Internationalization | open | S | low | `_updateProfiles()` exposes power-profiles-daemon's `PerformanceDegraded` machine token by only replacing hyphens with spaces. Values such as `lap-detected` remain lower-case English in an otherwise translated “Performance limited” row. Map known reasons to translatable user-facing labels and retain a readable fallback for future daemon values. |
| PT-228 | Documentation | open | XS | low | The architecture descriptions have fallen behind the source: README's Layout omits the new `lib/cinnamon-panel.js` boundary, and the `PowerToysApplet` header still calls the class “wiring, and only the wiring” while citing PT-32, PT-33, PT-34 and PT-37 as unfinished separations even though those items were implemented and removed. Update both descriptions to name the current boundaries and remaining responsibilities. |
| PT-253 | Documentation and assets | open | XS | low | README and the workflow commentary say the UPower typelib is what “the four libraries” open, but six runtime modules import it. The hardcoded count is already stale and adds no setup value. Remove the count and describe the typelib as the shared runtime dependency for modules that consume UPower data. |
| PT-254 | Internationalization | open | M | low | Visible numeric readings use `toFixed()` and concatenate units directly, so decimal separators and number/unit spacing remain English-style even when their surrounding labels are translated. Add a shared locale-aware numeric-and-unit formatter and route percentages, temperatures, power, frequency, voltage, fan speed and energy through it. |
