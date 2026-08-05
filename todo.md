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
| PT-174 | Documentation | open | M | medium | The README promises lid-closed DDC behavior that the implementation forbids. `README.md:53-64` says a laptop with its lid shut gets external-monitor sliders, while `settings-schema.json:114-118` and `applet.js:1811-1816,1915-1916` disable DDC on every machine that has a built-in backlight, regardless of lid/output state. Either detect the active output/lid topology and support the promise, or remove the promise and document the actual limitation consistently. |
