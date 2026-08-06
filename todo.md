# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Review scope: runtime source, configuration, install/uninstall paths, policy,
udev rules, styles, icons and documentation. Cache, build output, tests and
test-only tooling were excluded as requested.

Review categories: functional correctness; reliability, lifecycle and
concurrency; security and permissions; performance and resource use; UX and
accessibility; internationalization; compatibility and maintainability;
architecture and SOLID; coupling; wiring and integration; state management;
installation and operations; testing and quality assurance; documentation and
assets. Each item names its primary category even where the impact crosses
categories.

## Findings

| id | category | status | effort | severity | description |
| --- | --- | --- | --- | --- | --- |
| PT-353 | Reliability, lifecycle and concurrency | open | S | low | `lib/ddc.js` keeps timeout suppression in the module-global `_commandFailures` set, keyed by each complete `ddcutil` argument vector. A timed-out read or write is recovered only by a later successful command with the exact same bus, operation and value; if that monitor disappears, changing I2C/display identities and timed-out slider values can accumulate stale command strings for the rest of the module's lifetime. Give timeout failure state a bounded owner or explicitly forget obsolete command keys. |
| PT-354 | Performance and resource use | open | S | low | `lib/hardware.js` caches every resolved PCI name by address in `_pciNames`, but only evicts an entry if that same address is queried later with different IDs. Devices removed by a dock/eGPU hotplug disappear from subsequent discovery input, so their cached identity and name remain for the rest of the module's lifetime and repeated address churn grows the object. Prune the cache against each complete current PCI inventory or use a bounded cache. |

## Rejected, deferred and won't-fix findings

| id | category | status | effort | severity | description |
| --- | --- | --- | --- | --- | --- |
| PT-300 | Reliability, lifecycle and concurrency | rejected/won't fix | S | low | During screenshot-assisted live verification Cinnamon emitted one unattributed `Clutter-WARNING`: an `StIcon` was removed from a `ClutterBox` that was not its parent. Power Toys does not directly remove either of its `StIcon` actors, five isolated menu open/close cycles plus delayed-callback time emitted no log line, and three applet reloads were also clean. With no stack, reproduction, or Power Toys attribution, a runtime change would be speculative; revisit only if an applet-only reproduction identifies the owning actor. |
