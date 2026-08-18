#!/usr/bin/env python3
"""Hold the polkit action to what it is allowed to grant.

Well-formedness is the least of it: an action is a grant of root, and the
things worth failing a build over are the ones that widen that grant quietly.
So this asserts the shape positively - one action, naming exactly the helper
the applet runs - and then asserts the negatives: no authentication offered to
a caller who is not logged in at this machine, and no annotation beyond the
one that names the executable.
"""

import sys
import xml.etree.ElementTree as ET

# Every implicit authorization polkit understands. `no` refuses outright;
# anything else either authenticates the caller or grants without asking.
REFUSED = "no"
AUTHENTICATED = ("auth_admin", "auth_admin_keep", "auth_self", "auth_self_keep")
GRANTED = ("yes",)

# The one annotation this action carries. pkexec's allow_gui is deliberately
# absent - see the comment in the policy - and anything else appearing here is
# a change to what the action does, not a detail.
EXEC_PATH = "org.freedesktop.policykit.exec.path"
ALLOWED_ANNOTATIONS = frozenset({EXEC_PATH})

FAILURES = []


def fail(message: str) -> None:
    FAILURES.append(message)


def text_of(action: ET.Element, defaults: ET.Element, name: str) -> str:
    elements = defaults.findall(name)
    if len(elements) != 1:
        fail(f"{action.get('id')}: defaults must state exactly one {name}")
        return ""
    return (elements[0].text or "").strip()


def check_action(action: ET.Element, helper: str) -> None:
    identifier = action.get("id") or "<unnamed action>"
    if not action.get("id"):
        fail("every action must have an id")

    defaults = action.findall("defaults")
    if len(defaults) != 1:
        fail(f"{identifier}: must state exactly one defaults block")
        return
    defaults = defaults[0]

    for name in ("allow_any", "allow_inactive"):
        value = text_of(action, defaults, name)
        if value != REFUSED:
            fail(
                f"{identifier}: {name} is {value!r}; a caller that is not logged in at "
                f"this machine is refused, so it must be {REFUSED!r}. Widening it means "
                f"documenting the non-local use case in the policy first"
            )

    active = text_of(action, defaults, "allow_active")
    if active in GRANTED:
        fail(f"{identifier}: allow_active is {active!r}; a privileged change must authenticate")
    elif active not in AUTHENTICATED:
        fail(f"{identifier}: allow_active is {active!r}, which is not an authentication")

    annotations = {}
    for annotate in action.findall("annotate"):
        key = annotate.get("key") or ""
        annotations[key] = (annotate.text or "").strip()
    for key in sorted(set(annotations) - ALLOWED_ANNOTATIONS):
        fail(f"{identifier}: unexpected annotation {key}")
    if EXEC_PATH not in annotations:
        fail(f"{identifier}: must name the executable it authorises with {EXEC_PATH}")
    elif helper and annotations[EXEC_PATH] != helper:
        fail(
            f"{identifier}: {EXEC_PATH} is {annotations[EXEC_PATH]!r}, not the "
            f"installed helper {helper!r}"
        )


def main() -> int:
    if not 2 <= len(sys.argv) <= 3:
        print("usage: check-policy.py POLICY [HELPER_PATH]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    helper = sys.argv[2] if len(sys.argv) > 2 else ""

    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        print(f"policy FAIL  {path}: {error}", file=sys.stderr)
        return 1

    if root.tag != "policyconfig":
        fail(f"root element is {root.tag}, not policyconfig")
    actions = root.findall("action")
    if not actions:
        fail("the policy declares no action")
    for action in actions:
        check_action(action, helper)

    if FAILURES:
        for message in FAILURES:
            print(f"policy FAIL  {path}: {message}", file=sys.stderr)
        return 1
    print(f"policy ok    {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
