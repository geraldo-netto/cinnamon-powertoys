#!/bin/sh
# Hold the source tree to the same boundary as a Cinnamon Spices archive:
# files/ contains one UUID directory, and that directory contains runtime
# assets rather than repository tooling or generated output.

set -eu

UUID=${1:?usage: check-layout.sh UUID [FILES_ROOT]}
FILES_ROOT=${2:-files}
XLET_DIR=$FILES_ROOT/$UUID

fail() {
    echo "layout FAIL  $*" >&2
    exit 1
}

[ -d "$FILES_ROOT" ] || fail "missing $FILES_ROOT"
[ -d "$XLET_DIR" ] || fail "missing $XLET_DIR"

entry_count=$(find "$FILES_ROOT" -mindepth 1 -maxdepth 1 -print | wc -l)
[ "$entry_count" -eq 1 ] ||
    fail "$FILES_ROOT must contain only the UUID directory"

only_entry=$(find "$FILES_ROOT" -mindepth 1 -maxdepth 1 -print)
[ "$only_entry" = "$XLET_DIR" ] ||
    fail "$FILES_ROOT must contain $UUID and nothing else"

for wrapper in README.md info.json screenshot.png; do
    [ -f "$wrapper" ] || fail "missing Spices wrapper asset $wrapper"
done

for required in applet.js metadata.json settings-schema.json stylesheet.css \
        icon.png powertoys-helper lib icons po; do
    [ -e "$XLET_DIR/$required" ] || fail "missing runtime asset $required"
done

for entry in "$XLET_DIR"/* "$XLET_DIR"/.[!.]* "$XLET_DIR"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    case "$name" in
        applet.js|metadata.json|settings-schema.json|stylesheet.css|icon.png|powertoys-helper|lib|icons|po)
            ;;
        *) fail "unexpected top-level runtime entry $name" ;;
    esac
done

unwanted=$(find "$XLET_DIR" \
    \( -type d \( -name .git -o -name .github -o -name .coverage \
        -o -name build -o -name dist -o -name node_modules \
        -o -name test -o -name tests -o -name __pycache__ \) \
    -o -type f \( -name AGENTS.md -o -name todo.md -o -name package.json \
        -o -name package-lock.json -o -name '*.pyc' -o -name '*.test.js' \
        -o -name '*.spec.js' \) \) -print -quit)
[ -z "$unwanted" ] || fail "development artifact in runtime payload: $unwanted"

python3 - "$UUID" "$XLET_DIR/metadata.json" info.json "$XLET_DIR/icon.png" <<'PY'
import json
import struct
import sys

uuid, metadata_path, info_path, icon_path = sys.argv[1:]
with open(metadata_path, encoding="utf-8") as stream:
    metadata = json.load(stream)
with open(info_path, encoding="utf-8") as stream:
    info = json.load(stream)

if metadata.get("uuid") != uuid:
    raise SystemExit("layout FAIL  metadata UUID does not match the payload directory")
for field in ("uuid", "name", "description"):
    if field not in metadata:
        raise SystemExit(f"layout FAIL  metadata is missing {field}")
for field in ("icon", "dangerous", "last-edited"):
    if field in metadata:
        raise SystemExit(f"layout FAIL  Spices forbids metadata field {field}")

author = info.get("author")
if not isinstance(author, str) or not author or any(char.isspace() for char in author):
    raise SystemExit("layout FAIL  info.json author must be a GitHub username without whitespace")

with open(icon_path, "rb") as stream:
    header = stream.read(24)
if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
    raise SystemExit("layout FAIL  icon.png is not a PNG image")
width, height = struct.unpack(">II", header[16:24])
if width != height:
    raise SystemExit("layout FAIL  icon.png must be square")
PY

echo "layout ok    $XLET_DIR"
