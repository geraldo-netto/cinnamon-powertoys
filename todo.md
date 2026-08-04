# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Review scope: runtime source, configuration, install/uninstall paths, policy,
udev rules, styles, icons and documentation. Cache, build output, generated
artifacts, tests and test-only tooling were excluded as requested.

## High

- [ ] **S** — `cinnamon-powertoys@geraldo-netto/lib/ddc.js:L203,L366`: 🔴 bug: reads convert the monitor's raw VCP range to percent, but writes send that percent as the raw 0–255 value, so a display whose maximum is not 100 lands at the wrong brightness. Retain the reported maximum and scale percentages back to its raw range before `setvcp`.
- [ ] **S** — `cinnamon-powertoys@geraldo-netto/powertoys-helper:L84-L99,L162-L199`: 🔴 bug: multi-policy and multi-battery writes exit successfully when only one target accepted the value, leaving the machine split while the applet announces success. Count eligible targets, report partial failure, and identify every node that refused the write.
- [ ] **S** — `cinnamon-powertoys@geraldo-netto/applet.js:L1370-L1382`, `cinnamon-powertoys@geraldo-netto/lib/panel-text.js:L141-L153`: 🔴 bug: a missing primary device is presented as AC power even when UPower is unavailable, and the collected `OnBattery` value is ignored. Show battery/AC only when UPower establishes it and use an unavailable/unknown state otherwise.
- [ ] **S** — `cinnamon-powertoys@geraldo-netto/applet.js:L1385-L1395,L2584-L2587`: 🔴 bug: the ACPI platform-profile segment remains interactive when privileged controls are disabled, but every click is then refused by its runner. Make the segment read-only/hidden for that backend or stop gating platform-profile writes with the CPU-control setting, and align the setting text with the chosen behavior.
- [ ] **XS** — `cinnamon-powertoys@geraldo-netto/lib/profiles.js:L83-L98`: 🔴 bug: when the active profile is absent from a changed profile list, a positive step initializes at index 0 and then advances to index 1, skipping the first profile despite the documented fallback. Return the first profile directly when `from` is unknown.

## Medium

- [ ] **S** — `cinnamon-powertoys@geraldo-netto/lib/cpu.js:L65-L72`: 🟡 risk: the displayed maximum frequency comes only from the first cpufreq policy, which is not the processor-wide ceiling on heterogeneous systems. Read every policy and use the highest valid `cpuinfo_max_freq`.
- [ ] **S** — `cinnamon-powertoys@geraldo-netto/lib/bluez.js:L167-L183,L283-L299`: 🟡 risk: the BlueZ client watches object/property signals but not ownership of `org.bluez`, so an abrupt daemon stop can leave disconnected batteries displayed indefinitely. Watch the bus name, clear devices on vanish, and refresh the object tree on reappearance.
