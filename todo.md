# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Review scope: runtime source, configuration, install/uninstall paths, policy,
udev rules, styles, icons and documentation. Cache, build output, generated
artifacts, tests and test-only tooling were excluded as requested.

## High


## Medium

- [ ] **S** — `cinnamon-powertoys@geraldo-netto/lib/bluez.js:L167-L183,L283-L299`: 🟡 risk: the BlueZ client watches object/property signals but not ownership of `org.bluez`, so an abrupt daemon stop can leave disconnected batteries displayed indefinitely. Watch the bus name, clear devices on vanish, and refresh the object tree on reappearance.
