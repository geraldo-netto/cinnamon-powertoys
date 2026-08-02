# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

## Thirteenth pass — guards, and what arrives while something is in flight

Every source, case, tool and packaging file was read again. Two questions,
both grown out of the twelfth pass: which guards test for an answer the live
system never gives — a percentage that is never null, a comparison that hears
half of what the watch forwards — and what happens to the thing that arrives
while its backend is busy with the one before. And one row about the thread
all of this runs on.

## Closed

The twelfth pass asked what is in flight, what can start twice, what can be
replaced while something still holds the old one, and which flags have no way
back. Its six rows are closed between `4c780b9` and `d327587`. Four were
races that only open when two asynchronous things slip past each other, which
is why none of them had ever been seen: a queued pkexec outliving the applet,
two ddcutil calls on one bus, a wheel flick outrunning a monitor, and a
rediscovery landing inside a reading.

The eleventh pass asked where the seams are, what has to agree with what, and
what is wired to nothing. Its seven rows are closed between `286327a` and
`4cb4bbb`. The first was the shape of the project: 43% of the JavaScript sat
in the one file no case can load, so `lib/alerts.js` and `lib/reading.js` are
what came out of it, and applet.js is 3161 lines down to 2932. Two of the
remaining rows were paid for by that move within the hour — the
battery-threshold clamp and the profile-drawn helper are both covered now by
cases that could not have been written the day before.

The tenth pass read every tracked file again, this time including the two tools
the ninth pass had only run: the loader emulation was compared against
Cinnamon's own `fileUtils.js`, and the shipped SVGs, the translation scripts
and the parse check were read as sources. Its four rows are closed between
`e0ec291` and `c0279c6`. Three of the four were in the
paths that answer to hardware that is not there — a monitor that will not take
a write, a bluetooth daemon that stops, a setting switched off — which is where
this applet's failure cases nearly all live, because on the machine it is
written on none of them happen.

The ninth pass read every tracked file except the fixtures and the two
screenshots, and all ten of its rows are closed in the run of commits between
`a945999` and `a823395`. Two of them found more than they were opened for: the
first case written against the new profiles seam caught a property being
unpacked twice per read, and moving the doc blocks turned up a fifth that had
drifted the same way.
