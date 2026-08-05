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
| PT-190 | Wiring | open | S | high | `SensorSet._topologyKey()` in `lib/sensors.js` records only powercap directory names, while `discoverEnergyCounters()` excludes unreadable `energy_uj` files. Granting access with `make install-rapl` changes permissions but not those names, so the documented menu-open/minute rediscovery never exposes RAPL readings until the applet is reloaded. Include counter readability/identity in the topology signature or explicitly rediscover counters when access can have changed. |
| PT-191 | Architecture | open | M | high | The kernel backlight does not implement the serialized, exactly-once mutation contract already provided by the DDC backend: rapid slider events start overlapping `SetPercentageRemote` calls, and `stepBy()` dereferences `this._proxy` again after every reply, so an owner loss between notches can throw and strand its callback. Give backlight mutations a coalescing/serialization state machine, capture the proxy generation, and settle every queued caller once when the proxy disappears. |
| PT-192 | State machine | open | M | high | `DdcBacklight._adopt()` reuses a `DdcMonitor` solely by I2C bus, and `DdcMonitor.adopt()` changes only its display number and name. Replacing a physical monitor on the same socket therefore preserves the former device's `known`, `available`, percentage, pending write, and VCP maximum; if the first probe fails, stale state remains visible and later writes can use the wrong scale. Track the parsed EDID identity internally and replace or fully reset the monitor state when that identity changes. |
| PT-193 | State machine | open | XS | medium | `AlertManager._checkTemperature()` clears `_tempAlerted` whenever a temperature sample is `null`. A single transient sensor read failure while the machine is still hot therefore rearms the alert and the next valid sample sends a duplicate notification without crossing the recovery hysteresis. Preserve the latch on missing samples and clear it only when the alert is disabled or a valid reading confirms recovery. |
| PT-194 | Coupling | open | M | medium | `Reading.pickPower()` sums every GPU hwmon channel, even though `discoverSensors()` intentionally retains multiple `powerN_*` channels from one device and those channels may be overlapping whole-device and rail readings. This can make the panel report a fabricated GPU total, contradicting the tooltip's rule that such meters must stay separate to avoid double counting. Group readings by physical GPU and select a recognized whole-device channel, aggregating only sources with an explicit additive contract. |
| PT-195 | Installation | open | M | medium | Applet installation is rolled back as one transaction, but `tools/install-translations.sh` publishes each catalogue immediately and continues after compilation failures. A later failure restores the old applet while leaving any earlier languages updated, creating a mixed-version installation despite `install.sh` treating translations as part of the same operation. Compile and stage every catalogue first, then publish them atomically or restore the prior catalogues when the parent install fails. |
| PT-197 | Documentation | open | XS | low | README says monitor detection repeats once per second while either the menu is open or the pointer rests on the icon, but `_watchMonitors()` now performs only one warm-up probe for a tooltip hover and `_considerProbing()` reserves recurring probes for an open menu. Update the DDC behavior description so users are not promised recurring hover probes that no longer occur. |
| PT-198 | Internationalization | open | S | low | `Format.duration()` hardcodes English-style `h` and `m` suffixes and hour-before-minute ordering, then inserts that result beside translated remaining-time text. Locales that use different abbreviations or ordering therefore cannot translate a visible part of battery status. Format durations through translatable templates, including the hours-only/minutes-only variants needed to preserve the compact display. |
