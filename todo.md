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
| PT-300 | Reliability, lifecycle and concurrency | rejected/won't fix | S | low | During screenshot-assisted live verification Cinnamon emitted one unattributed `Clutter-WARNING`: an `StIcon` was removed from a `ClutterBox` that was not its parent. Power Toys does not directly remove either of its `StIcon` actors, five isolated menu open/close cycles plus delayed-callback time emitted no log line, and three applet reloads were also clean. With no stack, reproduction, or Power Toys attribution, a runtime change would be speculative; revisit only if an applet-only reproduction identifies the owning actor. |
| PT-301 | Testing and quality assurance | blocked | S | medium | The repository has no SonarQube Server or SonarQube Cloud project/scanner configuration, and the latest commit has only the GitHub Actions `check` result. Until a Sonar project is provisioned and automatic analysis or a CI scanner is connected, there is no Sonar quality gate or issue feed for this repository to inspect. |
| PT-302 | Testing and quality assurance | open | S | medium | The LCOV produced by `make coverage` identifies the temporary instrumented files under `.coverage/modules/`, not their tracked JavaScript sources. A future CI-based Sonar scan will not attribute that coverage to the applet libraries unless the LCOV `SF` paths are remapped through `.coverage/modules/sources.json` first. |
