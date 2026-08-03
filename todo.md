# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

## Comments that no longer describe the code

| id | severity | effort | description |
|----|----------|--------|-------------|
| PT-174 | low | XS | [`labelText`](cinnamon-powertoys@geraldo-netto/lib/panel-text.js#L126) spends a paragraph explaining that the frequency was taken out of the panel text, and then illustrates the separator with `"97% 12 W 4.30 GHz Balanced"` — a string this function can no longer produce. The example is the part of a comment that gets read; leave it naming the three parts that are still there. |
