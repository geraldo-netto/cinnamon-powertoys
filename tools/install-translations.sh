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
mkdir -p "$LOCALE_DIR"
STAGING=$(mktemp -d "$LOCALE_DIR/.${UUID}.stage.XXXXXX")
BACKUP=
BACKUP_READY=no
COMMITTED=no

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e

    if [ "$COMMITTED" != yes ] && [ "$BACKUP_READY" = yes ] &&
            [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
        rollback_status=0
        # Remove every catalogue this failed transaction may have published,
        # then restore the exact set that existed before it began.
        for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
            [ -f "$mo" ] || continue
            rm -f -- "$mo" || rollback_status=1
        done
        for old in "$BACKUP"/*.mo; do
            [ -f "$old" ] || continue
            language=$(basename "$old" .mo)
            target="$LOCALE_DIR/$language/LC_MESSAGES"
            mkdir -p "$target" || rollback_status=1
            cp -f -- "$old" "$target/$UUID.mo" || rollback_status=1
        done
        if [ "$rollback_status" -ne 0 ]; then
            echo "could not restore the previous translations from $BACKUP" >&2
            status=1
        fi
    fi

    [ -n "$STAGING" ] && rm -rf -- "$STAGING"
    [ -n "$BACKUP" ] && rm -rf -- "$BACKUP"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Compile the complete desired set before touching any installed catalogue.
# A broken language therefore cannot publish the valid languages before it.
for po in "$PO_DIR"/*.po; do
    # No translations yet is the normal case, not a failure.
    [ -f "$po" ] || continue
    language=$(basename "$po" .po)
    compiled="$STAGING/$language.mo"
    if ! msgfmt -o "$compiled" "$po"; then
        echo "could not compile $po" >&2
        exit 1
    fi
    chmod 0644 "$compiled"
    installed=$((installed + 1))
done

# Back up this domain only. The locale directories also contain every other
# application's catalogues and are never replaced wholesale.
BACKUP=$(mktemp -d "$LOCALE_DIR/.${UUID}.backup.XXXXXX")
for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
    [ -f "$mo" ] || continue
    language=$(basename "$(dirname "$(dirname "$mo")")")
    cp -f -- "$mo" "$BACKUP/$language.mo"
done
BACKUP_READY=yes

# STAGING is inside LOCALE_DIR, so each move is a same-filesystem atomic
# rename. The rollback trap covers a later publish or prune failure.
for compiled in "$STAGING"/*.mo; do
    [ -f "$compiled" ] || continue
    language=$(basename "$compiled" .mo)
    target="$LOCALE_DIR/$language/LC_MESSAGES"
    mkdir -p "$target"
    mv -f -- "$compiled" "$target/$UUID.mo"
done

# Keep the locale tree in step with po/. A language removed or renamed in the
# source has no loop iteration above, so overwriting current catalogues alone
# would leave its old translation installed forever. Match by language and
# remove only this gettext domain; every other application's catalogue in the
# same LC_MESSAGES directory is left alone.
for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
    [ -f "$mo" ] || continue
    language=$(basename "$(dirname "$(dirname "$mo")")")
    [ -f "$PO_DIR/$language.po" ] || rm -f -- "$mo"
done

if [ "$installed" -gt 0 ]; then
    echo "installed $installed translation(s) into $LOCALE_DIR"
fi

# Nothing that can fail follows this assignment. A failure before it restores
# the backup; reaching it makes the catalogue set the committed one.
COMMITTED=yes
