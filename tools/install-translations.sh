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

has_sources=no
for po in "$PO_DIR"/*.po; do
    if [ -f "$po" ]; then
        has_sources=yes
        break
    fi
done

if [ "$has_sources" = yes ] && ! command -v msgfmt > /dev/null 2>&1; then
    echo "msgfmt not found, skipping translations (install the gettext package)" >&2
    exit 0
fi

installed=0
failed=0
for po in "$PO_DIR"/*.po; do
    # No translations yet is the normal case, not a failure.
    [ -f "$po" ] || continue
    language=$(basename "$po" .po)
    target="$LOCALE_DIR/$language/LC_MESSAGES"
    mkdir -p "$target"
    temporary=$(mktemp "$target/.${UUID}.XXXXXX")
    if msgfmt -o "$temporary" "$po"; then
        chmod 0644 "$temporary"
        mv -f -- "$temporary" "$target/$UUID.mo"
        installed=$((installed + 1))
    else
        rm -f -- "$temporary"
        echo "could not compile $po" >&2
        failed=$((failed + 1))
    fi
done

# Keep the locale tree in step with po/. A language removed or renamed in the
# source has no loop iteration above, so overwriting current catalogues alone
# would leave its old translation installed forever. Match by language and
# remove only this gettext domain; every other application's catalogue in the
# same LC_MESSAGES directory is left alone.
if [ "$failed" -eq 0 ]; then
    for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
        [ -f "$mo" ] || continue
        language=$(basename "$(dirname "$(dirname "$mo")")")
        [ -f "$PO_DIR/$language.po" ] || rm -f -- "$mo"
    done
fi

if [ "$installed" -gt 0 ]; then
    echo "installed $installed translation(s) into $LOCALE_DIR"
fi

[ "$failed" -eq 0 ] || exit 1
