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
| PT-186 | Documentation | open | XS | low | The sensor filter documentation omits package and battery sensors that remain visible. `README.md:103-114` and `settings-schema.json:107-112` say disabling “all sensors” leaves only CPU/GPU readings, while `lib/sensors.js:36-50,70-73` also classifies package and battery sensors as primary. Document the complete primary set in both places, or change the filter to match the stated behavior. |
| PT-187 | Documentation | open | XS | low | RAPL instructions still say counters are discovered only at startup. `README.md:250-258` and `Makefile:117` tell the user to reload the applet, but `lib/sensors.js:670-674` and `applet.js:2228-2232,2317-2323` rediscover topology every minute and whenever the menu opens. Update the instructions to say the row appears on the next menu open or periodic discovery, without a reload. |
