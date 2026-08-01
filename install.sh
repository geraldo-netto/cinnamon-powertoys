#!/bin/sh
#
# Installs the Power Toys applet into the current user's Cinnamon applet
# directory. When Cinnamon is running the applet is reloaded in place, so a
# session restart is only needed on the very first install.

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

# Reloading only works once the applet is enabled on a panel; on a first
# install the call fails and the instructions below apply.
reloaded=no
if command -v gdbus > /dev/null 2>&1; then
    if gdbus call --session \
            --dest org.Cinnamon \
            --object-path /org/Cinnamon \
            --method org.Cinnamon.ReloadXlet "$UUID" APPLET > /dev/null 2>&1; then
        reloaded=yes
    fi
fi

if [ "$reloaded" = yes ]; then
    echo "Reloaded the running applet, no restart needed."
else
    echo
    echo "Next steps:"
    echo "  1. Restart Cinnamon (Alt+F2, then r) or log out and back in."
    echo "  2. Right click the panel, Applets, and enable \"Power Toys\"."
fi
