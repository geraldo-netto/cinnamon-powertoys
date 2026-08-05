# Project collaboration rules

- When a requirement or intended output is ambiguous, ask the user before choosing.
- Treat runtime source code as the single source of truth; when documentation or review findings diverge, update them to match the implemented behavior.
- Do not introduce unrequested formatting, metadata, or workflow conventions.
- Record every finding in `todo.md` as soon as it is discovered, whether it comes from a review, implementation, test, runtime observation, or another task.
- Keep `todo.md` findings in one Markdown table with the columns `id`, `category`, `status`, `effort`, `severity`, and `description`.
- Use `open` as the default finding status. Use `rejected/won't fix` for a deliberate non-fix and `blocked` only when a dependency must be completed first.
