# Power Toys — review findings

Review of every source file in the repository (applet, libraries, helper
script, packaging, docs). Build output, caches and `.git` were skipped; the
project has no generated files.

PT-12 to PT-29 come from the first pass, which looked for defects and gaps.
PT-30 onwards come from a second pass over the same files looking only at
architecture, coupling, SOLID and complexity — nothing there is a malfunction,
every item is about the shape of the code.

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-27 | medium | M | No tests. The throwaway smoke script used during development (sensor discovery, CPU control read-out, profile client, UPower snapshot) covers the risky parts and runs under plain `cjs`; move it into `tests/` and wire it to `make check`. |

## Laws of UX

A pass over the interface against [lawsofux.com](https://lawsofux.com/), naming
the law each finding sits under. Nothing here is a malfunction; every row is
about what the interface asks of the person reading it.

| id | severity | effort | description |
|----|----------|--------|-------------|
