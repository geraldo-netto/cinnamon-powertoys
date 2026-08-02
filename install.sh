#!/bin/sh
#
# Installs the Power Toys applet into the current user's Cinnamon applet
# directory. When Cinnamon is running the applet is reloaded in place, so a
# session restart is only needed on the very first install.

set -eu

UUID=cinnamon-powertoys@geraldo-netto
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)/$UUID

# PREFIX and DESTDIR are honoured so `make install` can hand its own settings
# through rather than doing the copy a second time and drifting from this.
PREFIX=${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}}
TARGET_DIR=${DESTDIR:-}$PREFIX/cinnamon/applets/$UUID

[ -d "$SOURCE_DIR" ] || { echo "missing $SOURCE_DIR" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
cp -r "$SOURCE_DIR" "$TARGET_DIR"
chmod +x "$TARGET_DIR/powertoys-helper"

echo "Installed to $TARGET_DIR"

# A .po in po/ does nothing until it is compiled into the directory the applet
# binds its text domain to.
"$(dirname "$0")/tools/install-translations.sh" install "${DESTDIR:-}$PREFIX/locale"

# A staged install is for building a package, not for using: it must not reach
# into the running session.
if [ -n "${DESTDIR:-}" ]; then
    exit 0
fi

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
