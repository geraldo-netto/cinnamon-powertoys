# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

Nothing open.

## Closed

The fifteenth pass read every tracked source again — the applet, the fourteen
libraries, the helper, the policy, the udev rule, the schema, the install
script and the workflow — asking what the two machines this is written for do
differently: the laptop with a daemon, and the one with only firmware. Its
eleven rows are closed in the run of commits opening at `922ec1a`, one commit
each. Most of what it found was on the second machine, which is the one nobody
develops on: profiles stepped in an order the firmware never offered, so the
wheel ran balanced, performance, lowest-of-all while the buttons two inches
away drew them the right way round; a platform profile that appeared after
login and was never looked for again; a charge limit discovered once in a
constructor, which settled the shape of the menu for the session.

Two were the same mistake in two places. A killed process was asked what it
exited with in lib/privileged.js, which lib/ddc.js had already been fixed for;
and a guard whose comment said it was about the machine was asked of a value
that is about the last D-Bus call, so a settings daemon restarting could put a
laptop on the I2C bus.

The largest row was the one that had been true since the eleventh pass: 37% of
the JavaScript sat in the file neither the coverage gate nor the mutation gate
can see, and PT-153 was sitting in it. `lib/sensor-rows.js` and
`lib/panel-text.js` are what came out, with forty cases that could not have
been written the day before, and applet.js is 3117 lines down to 2875.

The leak sweep it also carried came up empty: every signal is disconnected
where it was connected, every timer is removed on the way out, and the four
caches that outlive a poll — the alert set, the PCI names, the icon answers,
the device map — are each pruned or bounded. The one thing it found that holds
a resource held a file descriptor rather than memory, and only on the path
where a directory listing failed half way.
