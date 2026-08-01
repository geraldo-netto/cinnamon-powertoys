#!/bin/sh
#
# Installs the Power Toys applet into the current user's Cinnamon applet
# directory and restarts Cinnamon so the change is picked up.

set -eu

UUID=cinnamon-powertoys@geraldo-netto
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)/$UUID
TARGET_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets/$UUID

[ -d "$SOURCE_DIR" ] || { echo "missing $SOURCE_DIR" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
cp -r "$SOURCE_DIR" "$TARGET_DIR"
chmod +x "$TARGET_DIR/powertoys-helper"

echo "Installed to $TARGET_DIR"
echo
echo "Next steps:"
echo "  1. Restart Cinnamon (Alt+F2, then r) or log out and back in."
echo "  2. Right click the panel, Applets, and enable \"Power Toys\"."
