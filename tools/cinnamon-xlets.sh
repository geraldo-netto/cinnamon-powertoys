#!/bin/sh
# Exact Cinnamon xlet membership and live-source state from D-Bus replies.

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

# The source directory carried by a live applet instance. Unlike
# GetRunningXletUUIDs, this does not treat an enabled definition whose applet
# is still null as a running xlet. Returns 0 with the normalized path, 1 when
# no instance exists, and 2 when Cinnamon's answer cannot be observed safely.
cinnamon_xlet_live_path() {
    cinnamon_live_uuid=${1:-}
    [ -n "$cinnamon_live_uuid" ] || return 2
    cinnamon_live_json_uuid=$(POWERTOYS_XLET_UUID=$cinnamon_live_uuid python3 -c '
import json
import os
print(json.dumps(os.environ["POWERTOYS_XLET_UUID"]))
') || return 2
    cinnamon_live_reply=$(gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.Eval \
        "(function () { let manager = imports.ui.appletManager; let uuid = $cinnamon_live_json_uuid; let definition = manager.definitions.find(item => item && item.real_uuid === uuid && item.applet); return definition && definition.applet._meta ? definition.applet._meta.path : null; })()" \
        2>/dev/null) || return 2

    POWERTOYS_EVAL_RESULT=$cinnamon_live_reply python3 -c '
import ast
import json
import os
import re
import sys

raw = os.environ["POWERTOYS_EVAL_RESULT"]
match = re.fullmatch(r"\(true,\s*(.+)\)\s*", raw, re.S)
if match is None:
    sys.exit(2)
try:
    encoded = ast.literal_eval(match.group(1))
    path = json.loads(encoded)
except (SyntaxError, TypeError, ValueError):
    sys.exit(2)
if path is None:
    sys.exit(1)
if not isinstance(path, str) or not path:
    sys.exit(2)
print(os.path.realpath(path))
'
    cinnamon_live_status=$?
    [ "$cinnamon_live_status" -le 2 ] || cinnamon_live_status=2
    return "$cinnamon_live_status"
}
