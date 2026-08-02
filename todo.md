# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Ninth pass — the whole tree, read again

Every tracked file except the fixtures and the two screenshots: `applet.js`,
all sixteen libraries, the helper, the schema, the stylesheet, the Makefile,
`install.sh`, the workflow, the polkit action, the udev rule, the tests and the
README. Nothing generated and nothing under a cache was read. The suite is at
188 passing and the tree is clean, so none of what follows is a regression —
these are things the code has been doing all along.

## Behaviour

| id | severity | effort | description |
|----|----------|--------|-------------|

## Presentation

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-115 | medium | XS | Two heading rules in the stylesheet do nothing, for the reason `.powertoys-group-spaced` was already fixed for. [`.powertoys-group-title`](cinnamon-powertoys@geraldo-netto/stylesheet.css#L127) and [`.powertoys-subgroup-title`](cinnamon-powertoys@geraldo-netto/stylesheet.css#L150) are one class each; the theme sets padding on `.popup-menu-item`, which is also one class and is loaded after this file, so it ties on specificity and wins on order. Mint-Y-Dark-Aqua, the theme in use here, says `padding: .4em 1.75em` — so the 2px under a group heading is really the theme's, and neither `padding-top` has ever applied. Give both the two-class form the spaced rule already uses, then re-measure rather than assuming the numbers were right when they were written. |

## Code and tests

| id | severity | effort | description |
|----|----------|--------|-------------|

## Packaging and supply chain

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-120 | low | XS | The workflow downloads `cinnamon-xlet-makepot` from a raw GitHub URL, `chmod +x` it and runs it as root, pinned to the tag [`6.6.9`](.github/workflows/check.yml#L70). A tag is a moving reference; pin the commit, or check a known SHA-256 before making it executable. While there, the job declares no `permissions:` block, so it takes whatever the repository default is — `contents: read` is the whole of what it needs. |
| PT-121 | low | XS | The translation template ships with the extractor's placeholders: `SOME DESCRIPTIVE TITLE`, `PACKAGE VERSION`, `FIRST AUTHOR <EMAIL@ADDRESS>` and a `#, fuzzy` on the header itself. A translator's first sight of the project is a file that names neither it nor where to send the result. The [`pot` target](Makefile#L126) already strips one header line with `sed` to keep the output reproducible; stamp the identity in the same place, so the template stays a function of the sources and the workflow's diff check goes on passing. |
