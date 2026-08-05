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

TARGET_PARENT=$(dirname "$TARGET_DIR")
mkdir -p "$TARGET_PARENT"

# Build the complete replacement beside the live applet. A failed or
# interrupted copy can then touch only this private directory, not the version
# Cinnamon is currently loading.
STAGING=$(mktemp -d "$TARGET_PARENT/.${UUID}.new.XXXXXX")
BACKUP=
SWAPPED=no
COMMITTED=no

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM

    if [ "$COMMITTED" != yes ]; then
        if [ -n "$BACKUP" ] && { [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; }; then
            rm -rf -- "$TARGET_DIR"
            mv -- "$BACKUP" "$TARGET_DIR" || {
                echo "could not restore previous install from $BACKUP" >&2
                status=1
            }
        elif [ "$SWAPPED" = yes ]; then
            rm -rf -- "$TARGET_DIR"
        fi
    fi
    if [ -n "$STAGING" ] && { [ -e "$STAGING" ] || [ -L "$STAGING" ]; }; then
        rm -rf -- "$STAGING"
    fi
    if [ "$COMMITTED" = yes ] && [ -n "$BACKUP" ] &&
            { [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; }; then
        rm -rf -- "$BACKUP"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cp -R "$SOURCE_DIR/." "$STAGING/"
chmod 0755 "$STAGING"
chmod +x "$STAGING/powertoys-helper"

# These are the minimum files Cinnamon and the settings loader need. Check the
# staged tree before the first rename, while the old installation is intact.
for required in applet.js metadata.json settings-schema.json powertoys-helper; do
    [ -f "$STAGING/$required" ] || {
        echo "incomplete applet copy: missing $required" >&2
        exit 1
    }
done
[ -d "$STAGING/lib" ] || {
    echo "incomplete applet copy: missing lib" >&2
    exit 1
}

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    BACKUP=$(mktemp -d "$TARGET_PARENT/.${UUID}.old.XXXXXX")
    rmdir "$BACKUP"
    mv -- "$TARGET_DIR" "$BACKUP"
fi
mv -- "$STAGING" "$TARGET_DIR"
STAGING=
SWAPPED=yes


# A .po in po/ does nothing until it is compiled into the directory the applet
# binds its text domain to.
"$(dirname "$0")/tools/install-translations.sh" install "${DESTDIR:-}$PREFIX/locale"

# Translation installation is part of the operation too. Only after it has
# succeeded is the prior applet discarded; until here the EXIT trap restores
# it if anything fails.
COMMITTED=yes
if [ -n "$BACKUP" ]; then
    rm -rf -- "$BACKUP"
    BACKUP=
fi
trap - EXIT HUP INT TERM

echo "Installed to $TARGET_DIR"

# A staged install is for building a package, not for using: it must not reach
# into the running session.
if [ -n "${DESTDIR:-}" ]; then
    exit 0
fi

# Reloading an xlet does not drop the stylesheet it loaded, so a rule that was
# changed or deleted goes on applying until the theme is reloaded. The theme
# goes first and the applet second, deliberately: done the other way round the
# two races, and the theme reload can tear down an applet that is still coming
# up and leave it off the panel altogether. The files are already in place by
# now, so the theme reload sees the new stylesheet either way.
themed=no
if command -v gdbus > /dev/null 2>&1; then
    # Eval is refused unless the session has debugging enabled, hence the note
    # further down when this does not work.
    if gdbus call --session \
            --dest org.Cinnamon \
            --object-path /org/Cinnamon \
            --method org.Cinnamon.Eval \
            'imports.ui.main.themeManager._changeTheme();' 2>/dev/null | grep -q '^(true,'; then
        themed=yes
    fi
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
    if [ "$themed" = yes ]; then
        echo "Reloaded the running applet and the theme, so stylesheet changes are in too."
    else
        echo "Reloaded the running applet."
        echo
        echo "Note: a reload does not drop the old stylesheet. If you changed"
        echo "stylesheet.css, restart Cinnamon (Alt+F2, then r) to see it."
    fi
else
    echo
    echo "Next steps:"
    echo "  1. Restart Cinnamon (Alt+F2, then r) or log out and back in."
    echo "  2. Right click the panel, Applets, and enable \"Power Toys\"."
fi
