#!/bin/sh
# Remove the applet without leaving a live instance or a stale panel entry.

set -eu

UUID=cinnamon-powertoys@geraldo-netto
PREFIX=${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}}
TARGET_DIR=${DESTDIR:-}$PREFIX/cinnamon/applets/$UUID
SOURCE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCALE_DIR=${DESTDIR:-}$PREFIX/locale
TARGET_PARENT=$(dirname "$TARGET_DIR")

running_xlet() {
    output=$(gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.GetRunningXletUUIDs applet 2>/dev/null) || return 2
    printf '%s\n' "$output" | grep -Fq "$UUID"
}

backup_translations() {
    TRANSLATION_BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/.$UUID.locale.XXXXXX")
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

COMMITTED=no
SETTINGS_CHANGED=no
SOURCE_MOVED=no
SOURCE_BACKUP=
TRANSLATION_BACKUP=
TRANSLATION_BACKUP_READY=no
enabled=

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    assets_restored=yes

    if [ "$COMMITTED" != yes ] && [ "$SOURCE_MOVED" = yes ]; then
        rm -rf -- "$TARGET_DIR"
        if ! mv -- "$SOURCE_BACKUP" "$TARGET_DIR"; then
            echo "could not restore previous applet source from $SOURCE_BACKUP" >&2
            assets_restored=no
        else
            SOURCE_BACKUP=
            SOURCE_MOVED=no
        fi
    fi
    if [ "$COMMITTED" != yes ] && [ "$TRANSLATION_BACKUP_READY" = yes ] &&
            ! restore_translations; then
        echo "could not restore every previous translation; backup retained at $TRANSLATION_BACKUP" >&2
        assets_restored=no
    fi
    if [ "$COMMITTED" != yes ] && [ "$SETTINGS_CHANGED" = yes ]; then
        if [ "$assets_restored" = yes ]; then
            gsettings set org.cinnamon enabled-applets "$enabled" || {
                echo "could not restore the original enabled-applets setting" >&2
                status=1
            }
        else
            echo "the applet remains disabled because its assets could not be restored completely" >&2
            status=1
        fi
    fi

    if [ -n "$SOURCE_BACKUP" ] && [ "$SOURCE_MOVED" != yes ]; then
        rm -rf -- "$SOURCE_BACKUP"
    fi
    if [ -n "$TRANSLATION_BACKUP" ] && [ "$assets_restored" = yes ]; then
        rm -rf -- "$TRANSLATION_BACKUP"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

was_running=no
filtered=

# A package manager works on a filesystem image, not the logged-in user's
# panel configuration or session.
if [ -z "${DESTDIR:-}" ]; then
    for command in gsettings python3 gdbus; do
        command -v "$command" >/dev/null 2>&1 || {
            echo "$command is required to remove the live applet safely" >&2
            exit 1
        }
    done

    if running_xlet; then
        was_running=yes
    else
        running_status=$?
        if [ "$running_status" -ne 1 ]; then
            echo "could not determine whether $UUID is running; uninstall was not changed" >&2
            exit 1
        fi
    fi

    enabled=$(gsettings get org.cinnamon enabled-applets)
    filtered=$(POWERTOYS_ENABLED_APPLETS="$enabled" POWERTOYS_UUID="$UUID" python3 -c '
import ast
import os

raw = os.environ["POWERTOYS_ENABLED_APPLETS"]
if raw.startswith("@as "):
    raw = raw[4:]
entries = ast.literal_eval(raw)
uuid = os.environ["POWERTOYS_UUID"]
print(repr([entry for entry in entries if uuid not in entry.split(":")]))
')
fi

backup_translations

if [ -z "${DESTDIR:-}" ]; then
    if [ "$filtered" != "$enabled" ]; then
        trap '' HUP INT TERM
        gsettings set org.cinnamon enabled-applets "$filtered"
        SETTINGS_CHANGED=yes
        trap 'exit 1' HUP INT TERM
    fi

    if [ "$was_running" = yes ]; then
        attempts=0
        unloaded=no
        while [ "$attempts" -lt 5 ]; do
            if running_xlet; then
                attempts=$((attempts + 1))
                [ "$attempts" -ge 5 ] || sleep 0.2
                continue
            else
                running_status=$?
                if [ "$running_status" -eq 1 ]; then
                    unloaded=yes
                    break
                fi
                echo "could not verify that Cinnamon unloaded $UUID" >&2
                exit 1
            fi
        done
        if [ "$unloaded" != yes ]; then
            echo "Cinnamon did not unload $UUID; installed files were kept" >&2
            exit 1
        fi
    fi
fi

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    trap '' HUP INT TERM
    SOURCE_BACKUP=$(mktemp -d "$TARGET_PARENT/.$UUID.uninstall.XXXXXX")
    rmdir "$SOURCE_BACKUP"
    mv -- "$TARGET_DIR" "$SOURCE_BACKUP"
    SOURCE_MOVED=yes
    trap 'exit 1' HUP INT TERM
fi

"$SOURCE_ROOT/tools/install-translations.sh" uninstall \
    "$LOCALE_DIR"

COMMITTED=yes
trap - EXIT HUP INT TERM
if [ -n "$SOURCE_BACKUP" ] && ! rm -rf -- "$SOURCE_BACKUP"; then
    echo "warning: applet removed, but source backup remains at $SOURCE_BACKUP" >&2
fi
if ! rm -rf -- "$TRANSLATION_BACKUP"; then
    echo "warning: applet removed, but translation backup remains at $TRANSLATION_BACKUP" >&2
fi
echo "removed $TARGET_DIR"
