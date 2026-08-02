#!/bin/sh
#
# Compiles every translation in the applet's po/ directory into the place the
# applet binds its text domain to, and removes them again on request.
#
# Both install paths call this rather than carrying a copy of it: the
# directory here and the one lib/gettext.js binds to have to be the same
# directory, and that is easier to keep true in one file than in three.
#
# Usage: install-translations.sh install|uninstall [locale-root]

set -eu

UUID=cinnamon-powertoys@geraldo-netto
ACTION=${1:-install}
LOCALE_DIR=${2:-${XDG_DATA_HOME:-$HOME/.local/share}/locale}
PO_DIR=$(cd "$(dirname "$0")/.." && pwd)/$UUID/po

if [ "$ACTION" = uninstall ]; then
    removed=0
    # Only ever this applet's own catalogue, never the directory it sits in:
    # every other application on the machine keeps its own there too.
    for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
        [ -f "$mo" ] || continue
        rm -f "$mo"
        removed=$((removed + 1))
    done
    if [ "$removed" -gt 0 ]; then
        echo "removed $removed compiled translation(s)"
    fi
    exit 0
fi

if ! command -v msgfmt > /dev/null 2>&1; then
    echo "msgfmt not found, skipping translations (install the gettext package)" >&2
    exit 0
fi

installed=0
for po in "$PO_DIR"/*.po; do
    # No translations yet is the normal case, not a failure.
    [ -f "$po" ] || continue
    language=$(basename "$po" .po)
    target="$LOCALE_DIR/$language/LC_MESSAGES"
    mkdir -p "$target"
    if msgfmt -o "$target/$UUID.mo" "$po"; then
        installed=$((installed + 1))
    else
        echo "could not compile $po" >&2
    fi
done

if [ "$installed" -gt 0 ]; then
    echo "installed $installed translation(s) into $LOCALE_DIR"
fi
