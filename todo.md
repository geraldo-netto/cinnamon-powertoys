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
| PT-105 | medium | S | **Doherty threshold.** The panel keeps showing the old profile for up to one poll — four seconds by default — after the wheel, the middle button or the hotkey changed it. A notification stands in for the feedback the panel should be giving. The menu already draws the profile that was asked for rather than the one last read, through `_pendingProfile`; the panel item is handed the same reading and ignores it. [applet.js:2624](cinnamon-powertoys@geraldo-netto/applet.js#L2624) states the decision and its reasoning, which was written when the pending profile was only ever drawn in a menu that was closing. Give `PanelItem` the pending profile for its icon and its label; an error already clears it. |
| PT-107 | low | XS | **Law of proximity.** The panel text joins up to four unrelated figures with a plain space — `97% 12 W 4.30 GHz Balanced` — at [applet.js:432](cinnamon-powertoys@geraldo-netto/applet.js#L432), so nothing marks where one fact ends and the next starts. The menu's own summary line already uses `" · "` for this. |
| PT-108 | low | S | **Miller's law.** The tooltip has no ceiling: four to six lines about the machine, then one line per peripheral with a battery, unbounded ([applet.js:517](cinnamon-powertoys@geraldo-netto/applet.js#L517)). A desk with a mouse, a keyboard, a headset and two controllers makes an eleven line tooltip that is read as nothing at all. Cap the peripherals — three, lowest charge first, and a `+N more` line — and separate them from the machine's own lines with a blank one, so the tooltip is two chunks rather than one list. |
| PT-109 | low | XS | **Paradox of the active user.** The wheel, the middle button and the two hotkeys are invisible: nothing in the applet says they exist, and nobody opens a settings page to find out. The applet already introduces itself once per install ([applet.js:2042](cinnamon-powertoys@geraldo-netto/applet.js#L2042)), which is the one moment a person is certain to read it. Name the three there, in a sentence. |
| PT-110 | low | XS | **Selective attention.** [applet.js:416](cinnamon-powertoys@geraldo-netto/applet.js#L416) rules the temperature out of the panel because a number that moves in the corner of the eye cannot be ignored and nobody acts on 61 rather than 59. The frequency moves every poll and is no more actionable, and it is offered. It is off by default, so this is a question of whether the reasoning holds for both — answer it in one direction or the other rather than leaving the two rules side by side. |
| PT-111 | low | S | **Law of similarity.** With the icon on *Automatic* a laptop shows a symbolic battery and a desktop shows a coloured profile SVG. One applet, two visual languages, and on the desktop that icon is the only thing identifying it in the panel. Either the profile gauges get symbolic siblings for this case, or `auto` keeps the symbolic icon and says the profile some other way. |
| PT-112 | low | M | **Hick's law.** The *Panel* settings section is five controls — the icon source and four independent toggles — which is sixteen arrangements of the panel text, and almost everybody wants one of three. A single *Panel text* list with those three and a *Custom* entry that reveals the toggles would leave the same reach with less to decide. Low priority: the defaults are already the common case. |

## Documentation drift

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-113 | medium | S | [docs/menu.png](docs/menu.png) is out of date again. It was retaken for the two column menu; since then the menu has gained a third column, moved the brightness sliders into the first one under their own heading, dropped the *Configure Power Toys* row, unified the governor into the power profile and moved the supply line under *Sensors*. **Needs somebody at the machine**, and the monitor slider is still missing from any screenshot until the account's `i2c` group membership takes effect, which needs a logout. Capture with `org.Cinnamon.ScreenshotArea` over the menu's own rectangle, written to `$HOME` — it writes nothing to a path under `/tmp` — and check the image before committing it: a menu opened over D-Bus is open in Cinnamon's model without being raised, so a capture taken a moment late photographs whatever window is underneath. |
