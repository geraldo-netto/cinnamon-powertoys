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
BACKUP_READY=no
SWAPPED=no
COMMITTED=no
ROLLBACK_RELOAD=no

running_xlet() {
    output=$(gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.GetRunningXletUUIDs applet 2>/dev/null) || return 2
    printf '%s\n' "$output" | grep -Fq "$UUID"
}

wait_for_running_xlet() {
    attempts=0
    while [ "$attempts" -lt 5 ]; do
        if running_xlet; then
            return 0
        else
            result=$?
            if [ "$result" -eq 2 ]; then
                return 2
            fi
        fi
        attempts=$((attempts + 1))
        [ "$attempts" -ge 5 ] || sleep 0.2
    done
    return 1
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    restored=no

    if [ "$COMMITTED" != yes ]; then
        if [ "$BACKUP_READY" = yes ] && [ -n "$BACKUP" ] &&
                { [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; }; then
            rm -rf -- "$TARGET_DIR"
            mv -- "$BACKUP" "$TARGET_DIR" || {
                echo "could not restore previous install from $BACKUP" >&2
                status=1
            }
            if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
                restored=yes
            fi
        elif [ "$SWAPPED" = yes ]; then
            rm -rf -- "$TARGET_DIR"
            restored=yes
        fi
    fi
    if [ "$ROLLBACK_RELOAD" = yes ] && [ "$restored" = yes ]; then
        if gdbus call --session \
                --dest org.Cinnamon \
                --object-path /org/Cinnamon \
                --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null 2>&1 &&
                wait_for_running_xlet; then
            echo "Restored and reloaded the previous applet." >&2
        else
            echo "restored the previous files but could not reload the applet" >&2
            status=1
        fi
    fi
    if [ -n "$STAGING" ] && { [ -e "$STAGING" ] || [ -L "$STAGING" ]; }; then
        rm -rf -- "$STAGING"
    fi
    # A reservation that failed before the live tree was moved is not a
    # backup and must never replace that tree.
    if [ "$BACKUP_READY" != yes ] && [ -n "$BACKUP" ] &&
            { [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; }; then
        rm -rf -- "$BACKUP"
    fi
    if [ "$COMMITTED" = yes ] && [ "$BACKUP_READY" = yes ] && [ -n "$BACKUP" ] &&
            { [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; }; then
        rm -rf -- "$BACKUP"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Remember whether this operation is replacing a live panel instance. A first
# install is allowed to finish with next-step instructions; an upgrade of a
# running applet is not successful unless a running instance comes back.
was_running=unknown
if [ -z "${DESTDIR:-}" ] && command -v gdbus >/dev/null 2>&1; then
    if running_xlet; then
        was_running=yes
    else
        running_status=$?
        if [ "$running_status" -eq 1 ]; then
            was_running=no
        fi
    fi
fi

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
    # A signal trap can run between any two commands. Ignore termination only
    # across the three-command rename window, so cleanup can never mistake the
    # empty mktemp reservation for a completed backup or miss the successful
    # move before BACKUP_READY is recorded.
    trap '' HUP INT TERM
    BACKUP=$(mktemp -d "$TARGET_PARENT/.${UUID}.old.XXXXXX")
    rmdir "$BACKUP"
    mv -- "$TARGET_DIR" "$BACKUP"
    BACKUP_READY=yes
    trap 'exit 1' HUP INT TERM
fi
mv -- "$STAGING" "$TARGET_DIR"
STAGING=
SWAPPED=yes


# A .po in po/ does nothing until it is compiled into the directory the applet
# binds its text domain to.
"$(dirname "$0")/tools/install-translations.sh" install "${DESTDIR:-}$PREFIX/locale"

# A staged install is for building a package, not for using: it must not reach
# into the running session.
if [ -n "${DESTDIR:-}" ]; then
    COMMITTED=yes
    if [ "$BACKUP_READY" = yes ] && [ -n "$BACKUP" ]; then
        rm -rf -- "$BACKUP"
        BACKUP=
        BACKUP_READY=no
    fi
    trap - EXIT HUP INT TERM
    echo "Installed to $TARGET_DIR"
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
        if wait_for_running_xlet; then
            reloaded=yes
        fi
    fi
fi

if [ "$was_running" = yes ] && [ "$reloaded" != yes ]; then
    echo "the replacement did not start; restoring the previous applet" >&2
    ROLLBACK_RELOAD=yes
    exit 1
fi

# Copy, translations and (where there was a live instance) activation have all
# succeeded. Only now can the source backup stop being the rollback path.
COMMITTED=yes
if [ "$BACKUP_READY" = yes ] && [ -n "$BACKUP" ]; then
    rm -rf -- "$BACKUP"
    BACKUP=
    BACKUP_READY=no
fi
trap - EXIT HUP INT TERM

echo "Installed to $TARGET_DIR"

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
