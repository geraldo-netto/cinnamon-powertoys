#!/bin/sh
#
# Installs the Power Toys applet into the current user's Cinnamon applet
# directory. When Cinnamon is running the applet is reloaded in place, so a
# session restart is only needed on the very first install.

set -eu

UUID=cinnamon-powertoys@geraldo-netto
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)/files/$UUID

# PREFIX and DESTDIR are honoured so `make install` can hand its own settings
# through rather than doing the copy a second time and drifting from this.
PREFIX=${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}}
TARGET_DIR=${DESTDIR:-}$PREFIX/cinnamon/applets/$UUID
LOCALE_DIR=${DESTDIR:-}$PREFIX/locale

[ -d "$SOURCE_DIR" ] || { echo "missing $SOURCE_DIR" >&2; exit 1; }

TARGET_PARENT=$(dirname "$TARGET_DIR")
mkdir -p "$TARGET_PARENT"
. "$(dirname "$0")/tools/deployment-lock.sh"
acquire_deployment_lock "$TARGET_DIR"
. "$(dirname "$0")/tools/cinnamon-xlets.sh"

# Build the complete replacement beside the live applet. A failed or
# interrupted copy can then touch only this private directory, not the version
# Cinnamon is currently loading.
STAGING=$(mktemp -d "$TARGET_PARENT/.${UUID}.new.XXXXXX")
BACKUP=
BACKUP_READY=no
SWAPPED=no
COMMITTED=no
ROLLBACK_RELOAD=no
THEME_CHANGED=no
TRANSLATION_BACKUP=
TRANSLATION_BACKUP_READY=no
TRANSLATION_BACKUP_RETAINED=no

# Whether the applet Cinnamon is running is the one just published.
#
#   0  it is, and it was loaded from the expected directory
#   1  it is not running, or it is running from somewhere else
#   2  Cinnamon's answer could not be observed at all
#   3  it is running, but which files it loaded cannot be observed
#
# Three is the ordinary case on a stock session. Reading an applet's source
# directory needs org.Cinnamon.Eval, which Cinnamon refuses unless the
# `development-tools` gsettings key is on, and that key is off by default. The
# refusal used to be indistinguishable from an unreachable session, so every
# upgrade of a running applet reported "the replacement did not start" and
# rolled itself back over a reload that had in fact succeeded. So a refusal
# falls back to GetRunningXletUUIDs, which needs no Eval: it can say the applet
# is loaded, and cannot say from where, which the caller then does not claim.
wait_for_running_xlet() {
    expected_source=$1
    attempts=0
    while [ "$attempts" -lt 5 ]; do
        if running_source=$(cinnamon_xlet_live_path "$UUID"); then
            if [ "$running_source" = "$expected_source" ]; then
                return 0
            fi
        else
            result=$?
            if [ "$result" -eq 2 ]; then
                return 2
            fi
            if [ "$result" -eq 3 ]; then
                if cinnamon_xlet_running "$UUID"; then
                    return 3
                fi
                membership=$?
                [ "$membership" -eq 1 ] || return 2
            fi
        fi
        attempts=$((attempts + 1))
        [ "$attempts" -ge 5 ] || sleep 0.2
    done
    return 1
}

reload_theme() {
    command -v gdbus >/dev/null 2>&1 || return 1
    gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.Eval \
        'imports.ui.main.themeManager._changeTheme();' 2>/dev/null | grep -q '^(true,'
}

backup_translations() {
    TRANSLATION_BACKUP=$(mktemp -d "$TARGET_PARENT/.${UUID}.locale.XXXXXX")
    for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
        [ -f "$mo" ] || continue
        language=$(basename "$(dirname "$(dirname "$mo")")")
        cp -f -- "$mo" "$TRANSLATION_BACKUP/$language.mo"
    done
    TRANSLATION_BACKUP_READY=yes
}

restore_translations() {
    restored_status=0
    for mo in "$LOCALE_DIR"/*/LC_MESSAGES/"$UUID.mo"; do
        [ -f "$mo" ] || continue
        rm -f -- "$mo" || restored_status=1
    done
    for old in "$TRANSLATION_BACKUP"/*.mo; do
        [ -f "$old" ] || continue
        language=$(basename "$old" .mo)
        target="$LOCALE_DIR/$language/LC_MESSAGES"
        mkdir -p "$target" || restored_status=1
        cp -f -- "$old" "$target/$UUID.mo" || restored_status=1
    done
    return "$restored_status"
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
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
    if [ "$COMMITTED" != yes ] && [ "$TRANSLATION_BACKUP_READY" = yes ] &&
            ! restore_translations; then
        echo "could not restore every previous translation; backup retained at $TRANSLATION_BACKUP" >&2
        TRANSLATION_BACKUP_RETAINED=yes
        status=1
    fi
    if [ "$ROLLBACK_RELOAD" = yes ] && [ "$restored" = yes ]; then
        if [ "$THEME_CHANGED" = yes ] && ! reload_theme; then
            echo "restored the previous stylesheet but could not reload the theme" >&2
            status=1
        fi
        restore_status=1
        if gdbus call --session \
                --dest org.Cinnamon \
                --object-path /org/Cinnamon \
                --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null 2>&1; then
            restore_status=0
            wait_for_running_xlet "$TARGET_SOURCE" || restore_status=$?
        fi
        if [ "$restore_status" -eq 0 ] || [ "$restore_status" -eq 3 ]; then
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
    if [ "$TRANSLATION_BACKUP_RETAINED" != yes ] && [ -n "$TRANSLATION_BACKUP" ]; then
        rm -rf -- "$TRANSLATION_BACKUP"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# An existing target might be the source of a live panel instance. Absence is a
# valid answer there; a failed query is not, because publishing a replacement
# without verifying its reload could leave the panel on files that were moved
# away. A genuinely absent target cannot be that live source, so a first install
# does not depend on reaching a Cinnamon session at all.
was_running=no
TARGET_SOURCE=
if [ -z "${DESTDIR:-}" ] &&
        { [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; }; then
    if command -v gdbus >/dev/null 2>&1; then
        command -v python3 >/dev/null 2>&1 || {
            echo "python3 is required to inspect the running Cinnamon applets safely" >&2
            exit 1
        }
        TARGET_SOURCE=$(python3 -c \
            'import os, sys; print(os.path.realpath(sys.argv[1]))' "$TARGET_DIR") || {
            echo "could not resolve the requested applet target" >&2
            exit 1
        }
        if cinnamon_xlet_running "$UUID"; then
            was_running=yes
        else
            running_status=$?
            if [ "$running_status" -ne 1 ]; then
                echo "could not determine whether $UUID is running; install was not changed" >&2
                exit 1
            fi
        fi
    else
        echo "gdbus is required to replace an existing live install safely" >&2
        exit 1
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

# The translation helper has its own transaction, but its successful commit
# precedes runtime verification. Retain the outer operation's prior catalogue
# set so a later applet/theme failure can roll source, CSS and text back as one.
backup_translations

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
# Publishing the staged tree and recording that publication are one state
# transition. In particular on a first install there is no backup to reveal
# the rename to cleanup, so a signal between these commands must not leave an
# uncommitted applet visible.
trap '' HUP INT TERM
mv -- "$STAGING" "$TARGET_DIR"
STAGING=
SWAPPED=yes
trap 'exit 1' HUP INT TERM


# A .po in po/ does nothing until it is compiled into the directory the applet
# binds its text domain to.
"$(dirname "$0")/tools/install-translations.sh" install "$LOCALE_DIR"

# A staged install is for building a package, not for using: it must not reach
# into the running session.
if [ -n "${DESTDIR:-}" ]; then
    COMMITTED=yes
    if [ "$BACKUP_READY" = yes ] && [ -n "$BACKUP" ]; then
        rm -rf -- "$BACKUP"
        BACKUP=
        BACKUP_READY=no
    fi
    rm -rf -- "$TRANSLATION_BACKUP"
    TRANSLATION_BACKUP=
    TRANSLATION_BACKUP_READY=no
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
# Eval is refused unless the session has debugging enabled, hence the note
# further down when this does not work.
if reload_theme; then
    themed=yes
    THEME_CHANGED=yes
fi

# Reloading only works once the applet is enabled on a panel; on a first
# install the call fails and the instructions below apply.
reloaded=no
verified=no
if command -v gdbus > /dev/null 2>&1 &&
        gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.ReloadXlet "$UUID" APPLET > /dev/null 2>&1; then
    reload_status=0
    wait_for_running_xlet "$TARGET_SOURCE" || reload_status=$?
    case "$reload_status" in
        0) reloaded=yes; verified=yes ;;
        3) reloaded=yes ;;
    esac
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
rm -rf -- "$TRANSLATION_BACKUP"
TRANSLATION_BACKUP=
TRANSLATION_BACKUP_READY=no
trap - EXIT HUP INT TERM

echo "Installed to $TARGET_DIR"

if [ "$reloaded" = yes ] && [ "$verified" != yes ]; then
    echo
    echo "Note: the reloaded applet is running, but which files it loaded could"
    echo "not be checked - reading that needs Cinnamon's Eval interface, which is"
    echo "off unless the org.cinnamon development-tools setting is on."
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
