#!/bin/sh
# Exact Cinnamon running-xlet membership from gdbus's textual GVariant reply.

cinnamon_xlet_running() {
    cinnamon_xlet_uuid=${1:-}
    [ -n "$cinnamon_xlet_uuid" ] || return 2
    cinnamon_xlet_reply=$(gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.GetRunningXletUUIDs applet 2>/dev/null) || return 2

    POWERTOYS_RUNNING_XLETS=$cinnamon_xlet_reply \
    POWERTOYS_XLET_UUID=$cinnamon_xlet_uuid \
    python3 -c '
import ast
import os
import re
import sys

try:
    text = os.environ["POWERTOYS_RUNNING_XLETS"]
    text = re.sub(r"^\(\s*@as\s+", "(", text, count=1)
    value = ast.literal_eval(text)
    if not isinstance(value, tuple) or len(value) != 1:
        raise ValueError("unexpected result tuple")
    uuids = value[0]
    if not isinstance(uuids, (list, tuple)) or not all(isinstance(v, str) for v in uuids):
        raise ValueError("unexpected UUID array")
except (KeyError, SyntaxError, ValueError):
    sys.exit(2)

sys.exit(0 if os.environ["POWERTOYS_XLET_UUID"] in uuids else 1)
'
    cinnamon_xlet_status=$?
    [ "$cinnamon_xlet_status" -le 2 ] || cinnamon_xlet_status=2
    return "$cinnamon_xlet_status"
}
