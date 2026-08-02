# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Eighth pass — the panel, read against the laws of UX

The panel item alone: its icon, its text, its tooltip, and what the wheel and
the middle button do. Each row names the law it comes from, which is there to
say why the row is worth doing and not to decorate it. The menu was reviewed
in the pass before this one and is not revisited here.

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-112 | low | M | **Hick's law.** The *Panel* settings section is five controls — the icon source and four independent toggles — which is sixteen arrangements of the panel text, and almost everybody wants one of three. A single *Panel text* list with those three and a *Custom* entry that reveals the toggles would leave the same reach with less to decide. Low priority: the defaults are already the common case. |

## Documentation drift

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-113 | medium | S | [docs/menu.png](docs/menu.png) is out of date again. It was retaken for the two column menu; since then the menu has gained a third column, moved the brightness sliders into the first one under their own heading, dropped the *Configure Power Toys* row, unified the governor into the power profile and moved the supply line under *Sensors*. **Needs somebody at the machine**, and the monitor slider is still missing from any screenshot until the account's `i2c` group membership takes effect, which needs a logout. Capture with `org.Cinnamon.ScreenshotArea` over the menu's own rectangle, written to `$HOME` — it writes nothing to a path under `/tmp` — and check the image before committing it: a menu opened over D-Bus is open in Cinnamon's model without being raised, so a capture taken a moment late photographs whatever window is underneath. |
