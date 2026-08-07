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
| PT-302 | Testing and quality assurance | open | S | medium | The LCOV produced by `make coverage` identifies the temporary instrumented files under `.coverage/modules/`, not their tracked JavaScript sources. A future CI-based Sonar scan will not attribute that coverage to the applet libraries unless the LCOV `SF` paths are remapped through `.coverage/modules/sources.json` first. |
| PT-304 | Testing and quality assurance | blocked | XS | medium | The SonarQube Cloud project has no quality gate assigned: its API reports status `NONE`, and the GitHub check reports “Quality Gate not computed.” Assigning a quality gate is an external SonarQube project-administration change; source fixes alone cannot make the check enforce a result. |
| PT-305 | Compatibility and maintainability | rejected/won't fix | XS | high | Sonar rule `javascript:S3504` reports 86 runtime top-level `var` declarations. In a CJS imports module those declarations are the public module surface; changing them to block-scoped `let` or `const` would stop consumers from importing the constants, functions, and classes, so the generic browser/Node recommendation is not applicable. |
| PT-306 | Compatibility and maintainability | rejected/won't fix | XS | medium | Sonar recommends newer built-ins including `Object.hasOwn`, `Array.at`, and `Array.toSorted`. The applet's Cinnamon 5.4 floor uses Mozilla JavaScript 78, which predates the first two; `toSorted` is absent even from the installed CJS 115. These style-only rewrites are not applicable to the supported runtime range. |
| PT-307 | Reliability, lifecycle and concurrency | rejected/won't fix | XS | low | Sonar reports documented empty catches in best-effort Cinnamon compatibility, cleanup, cancellation, and rollback paths. Those operations deliberately continue after an optional restoration or release fails, and turning them into user-visible errors or aborts would make cleanup less reliable; retain the contained fallback behavior. |
| PT-308 | Security and permissions | rejected/won't fix | XS | low | Sonar's Python path rules treat the three explicit operands of `tools/build-policy.py` as an LLM-controlled filesystem boundary. The script is a non-privileged build CLI invoked with trusted repository, translation-directory, and temporary-output paths; a caller able to choose different paths already has exactly the same filesystem permissions as the script, so validating them against an invented root would change the tool's intended interface without adding a security boundary. |
| PT-312 | Testing and quality assurance | rejected/won't fix | XS | low | The clipped-note accessibility test searches `applet.js` for the exact call text `this.actor.set_accessible_name(text)` instead of exercising the row. A semantics-preserving local rename caused the otherwise unrelated assertion to fail; tests are outside this review's requested scope, so retain the harmless local name rather than expanding this Sonar cleanup into a test-harness rewrite. |
| PT-313 | Reliability, lifecycle and concurrency | rejected/won't fix | XS | low | Sonar recommends combining the two UPower manager signal IDs into one `Array.push` call. The current calls intentionally publish the first ID before attempting the second so a throw during the second subscription can disconnect the first; evaluating both as arguments before `push` would lose that rollback handle and leak the signal. |
