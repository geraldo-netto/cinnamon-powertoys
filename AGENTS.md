# Project collaboration rules

- When a requirement or intended output is ambiguous, ask the user before choosing.
- Treat runtime source code as the single source of truth; when documentation or review findings diverge, update them to match the implemented behavior.
- Do not introduce unrequested formatting, metadata, or workflow conventions.
- Record every finding in `TODO.md` as soon as it is discovered, whether it comes from a review, implementation, test, runtime observation, or another task.
- Keep `TODO.md` limited to `# TODO` and exactly three sections in this order: `## Open`, `## Blocked / Deferred`, and `## Rejected / Won't fix`.
- Use exactly `| id | status | severity | effort | description |` for all three tables.
- Use only lowercase statuses: `open` or `in_progress` in Open, `blocked` or `deferred` in Blocked / Deferred, and `rejected` or `wont_fix` in Rejected / Won't fix.
- Use lowercase `high`, `medium`, or `low` severity and `xs`, `s`, `m`, `l`, or `xl` effort; use `—` when either value is unavailable.
