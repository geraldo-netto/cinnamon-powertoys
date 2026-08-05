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
| PT-205 | Functional correctness | open | M | medium | `SensorSet` topology signatures contain only the names directly under `hwmon`, `thermal` and `powercap`; they omit the sensor nodes inside an existing device directory. A driver that adds, removes or renames `tempN`, `fanN` or `powerN` nodes without creating a new `hwmonN` is never rediscovered, leaving readings missing or stale until some unrelated root-level topology change or an applet reload. Include nested node inventories in the asynchronous topology comparison or monitor those directories for changes. |
| PT-206 | Performance | open | M | medium | The asynchronous sensor-discovery path still performs synchronous sysfs work on Cinnamon's main thread: `_scanSensors()` calls `_hwmonIdentity()`, `deviceIdentity()` and `IO.readLink()` several times per hwmon and thermal entry after the async metadata batch completes. This undercuts the non-blocking discovery guarantee and can still stall the compositor on a large or slow sysfs tree. Batch symlink targets through asynchronous Gio queries and assemble identities only after they return. |
| PT-207 | Installation and operations | open | M | high | `PrivilegedHelper.path()` always prefers the system helper based only on path existence; there is no executable/regular-file check or protocol/version handshake. After an applet upgrade, an old or damaged `/usr/local/lib/cinnamon-powertoys/powertoys-helper` silently overrides the bundled helper, so new commands, error codes or transactional guarantees may not exist even though the current UI relies on them. Validate helper health and protocol compatibility before selection and report a stale system installation explicitly. |
| PT-208 | Installation reliability | open | XS | medium | The translation installer's rollback path deletes `BACKUP` unconditionally even when restoring old catalogues failed. The diagnostic says restoration failed “from” that directory, but cleanup immediately removes the only preserved copies, preventing manual recovery and making a publication failure destructive. Keep the backup on rollback failure and print its retained path; remove it only after a complete restore or commit. |
| PT-209 | Functional correctness | open | XS | medium | Charge-limit discovery accepts only power supplies whose `type` is `Battery`, but `powertoys-helper` writes every directory that exposes `charge_control_end_threshold` without checking its type. The privileged write set can therefore be broader than the batteries the UI counted and described. Apply the same `type=Battery` predicate in the helper before building the transaction. |
| PT-210 | Architecture and coupling | open | M | medium | `PanelPresenter` reaches through Cinnamon's private `_applet_tooltip`, `_tooltip` and `_applet_icon` fields and replaces the tooltip instance's `show()` and `hide()` methods in place. A private-field or tooltip-lifecycle change can break panel updates across the declared Cinnamon versions, and there is no single fallback boundary. Isolate these accesses in a feature-detecting Cinnamon adapter with public-API fallbacks and explicit cleanup rather than coupling presentation logic directly to shell internals. |
| PT-211 | Documentation | open | XS | low | README's Requirements section says DDC is “Never probed on a machine that has a backlight of its own,” while the implemented PT-174 behavior, the Features section and the setting tooltip deliberately probe external monitors on such laptops when UPower reports the lid closed. Rewrite the requirement to describe the usable-built-in-screen condition so setup guidance matches runtime behavior. |
