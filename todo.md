# Power Toys — review findings

Severity: **high** the user sees something wrong or missing, or the item blocks
other work · **medium** it makes changes slow or risky, or costs the user
comfort · **low** polish, tidying, convenience.

Effort: **XS** minutes · **S** under an hour · **M** an hour or a few · **L** a day or more.

Rows whose id ends in a letter are the parts of the row above them; the parent
row keeps the effort for the whole and is done when its parts are. Parts were
only split out where each one can be written, reviewed and committed on its
own — items that are genuinely a single change were left whole.

Nothing open. The ninth pass read every tracked file except the fixtures and
the two screenshots, and all ten of its rows are closed in the run of commits
that follows it in the log. Two of them found more than they were opened for:
the first case written against the new profiles seam caught a property being
unpacked twice per read, and moving the doc blocks turned up a fifth that had
drifted the same way.
