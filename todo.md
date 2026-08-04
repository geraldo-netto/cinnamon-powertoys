# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Review scope: runtime source, configuration, install/uninstall paths, policy,
udev rules, styles, icons and documentation. Cache, build output, generated
artifacts, tests and test-only tooling were excluded as requested.

## High

- [ ] **S** — `cinnamon-powertoys@geraldo-netto/applet.js:L1370-L1382`, `cinnamon-powertoys@geraldo-netto/lib/panel-text.js:L141-L153`: 🔴 bug: a missing primary device is presented as AC power even when UPower is unavailable, and the collected `OnBattery` value is ignored. Show battery/AC only when UPower establishes it and use an unavailable/unknown state otherwise.
- [ ] **S** — `cinnamon-powertoys@geraldo-netto/applet.js:L1385-L1395,L2584-L2587`: 🔴 bug: the ACPI platform-profile segment remains interactive when privileged controls are disabled, but every click is then refused by its runner. Make the segment read-only/hidden for that backend or stop gating platform-profile writes with the CPU-control setting, and align the setting text with the chosen behavior.

## Medium

- [ ] **S** — `cinnamon-powertoys@geraldo-netto/lib/bluez.js:L167-L183,L283-L299`: 🟡 risk: the BlueZ client watches object/property signals but not ownership of `org.bluez`, so an abrupt daemon stop can leave disconnected batteries displayed indefinitely. Watch the bus name, clear devices on vanish, and refresh the object tree on reappearance.
