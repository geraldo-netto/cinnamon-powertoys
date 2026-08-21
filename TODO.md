# TODO

## Open

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| PT-448 | open | low | xs | Make tools/build-package.py emit explicit directory entries and modes. It fixes file modes but omits directories, so extraction creates lib, ui, icons, and po with the recipient's umask instead of the release's intended mode. |

## Blocked / Deferred

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| PT-357c | blocked | medium | s | Decide whether to introduce a pinned Node toolchain and lockfile for ESLint under the Mozilla JavaScript 78 runtime floor. The existing CJS scope checker covers identifier resolution, but the rest of the ESLint rule set needs reproducible npm installation. |
| PT-358 | blocked | medium | m | The owner must lift the standing maintainer-only mutation-testing policy before make mutants can run in CI, enforce its threshold, and retain reports. |
| PT-368 | blocked | low | s | Verify the responsive menu on live Cinnamon: two- and one-column layouts, narrow-work-area sizing, tab order, scrolling, and the guarded single-column fallback. Unit cases cannot establish rendered behavior. |
| PT-379 | blocked | medium | s | Decide how changing the battery end threshold handles a conflicting start threshold: document automatic coercion at authorization time, reject the request, or report the adjustment back in the notification. |
| PT-421 | blocked | medium | s | Decide whether CI should install Cinnamon and Muffin typelibs so the shell-load gate runs on every push. The alternative keeps a large desktop dependency out of CI but leaves the gate maintainer-machine-only. |
| PT-437 | blocked | low | xs | Decide whether make dist should run make check, duplicating the CI suite, or whether release documentation should require a separate check and accept that local archives are not self-gating. |
| PT-438 | blocked | low | xs | A maintainer must run the mutation tool once to exercise its recursive lib and tests/cases enumeration; standing policy forbids this workflow from running mutation campaigns. |
| PT-444 | blocked | low | s | Decide how monitor adoption behaves when ddcutil supplies neither an I2C bus nor EDID identity. Reusing display order can assign the wrong slider after unplugging; refusing adoption rebuilds every unidentified monitor and loses transient state. |
| PT-443 | blocked | low | s | Decide whether the first-run gesture notification waits for hardware probes and names only available controls, or arrives immediately and may advertise inert brightness and keyboard-backlight defaults. |

## Rejected / Won't fix

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| PT-300 | rejected | low | s | The unattributed Clutter StIcon warning has no stack, reproduction, or Power Toys ownership, and isolated menu cycles and reloads do not reproduce it. Revisit only with an applet-specific reproduction. |
| PT-306 | rejected | medium | xs | Object.hasOwn, Array.at, and Array.toSorted are unavailable at the Cinnamon 5.4 Mozilla JavaScript 78 floor, so Sonar's modern-built-in rewrites are incompatible. |
| PT-307 | rejected | low | xs | Empty catches are deliberate best-effort cleanup, cancellation, compatibility, and rollback paths; surfacing or aborting optional restoration failures would reduce reliability. |
| PT-308 | rejected | low | xs | tools/build-policy.py receives trusted developer CLI paths under the caller's existing filesystem authority, not model-controlled input; inventing a root restriction would change its interface without adding a boundary. |
| PT-312 | wont_fix | low | xs | The clipped-note accessibility test is coupled to exact source text and can fail after a local rename, but expanding this work into a test-harness rewrite was declined. |
| PT-313 | rejected | low | xs | Combining two UPower subscriptions inside one Array.push would evaluate both before publishing either handle, so a second-subscription failure could no longer disconnect the first. |
| PT-422 | wont_fix | low | xs | Two widget tests must inspect source text because PopupMenu subjects crash without a Clutter stage. Converting them would require a second runner that works only on machines with a Cinnamon session. |
| PT-423 | wont_fix | medium | m | Do not claim coverage for loaded-but-unconstructed UI modules. Constructing their methods requires a Cinnamon stage; counting them at zero would permanently fail the per-function gate or require a meaningless second threshold. |
| PT-425 | rejected | low | s | The large sensor and DDC case files each model one coherent captured-machine fixture. Splitting by production module would duplicate the harness and fragment a single system scenario. |
