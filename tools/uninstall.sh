#!/bin/sh
# Remove the applet without leaving a live instance or a stale panel entry.

set -eu

UUID=cinnamon-powertoys@geraldo-netto
PREFIX=${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}}
TARGET_DIR=${DESTDIR:-}$PREFIX/cinnamon/applets/$UUID
SOURCE_ROOT=$(cd "$(dirname "$0")/.." && pwd)

running_xlet() {
    output=$(gdbus call --session \
        --dest org.Cinnamon \
        --object-path /org/Cinnamon \
        --method org.Cinnamon.GetRunningXletUUIDs applet 2>/dev/null) || return 1
    printf '%s\n' "$output" | grep -Fq "$UUID"
}

# A package manager works on a filesystem image, not the logged-in user's
# panel configuration or session.
if [ -z "${DESTDIR:-}" ]; then
    command -v gsettings >/dev/null 2>&1 || {
        echo "gsettings is required to remove the applet from the panel" >&2
        exit 1
    }
    command -v python3 >/dev/null 2>&1 || {
        echo "python3 is required to update Cinnamon's applet list safely" >&2
        exit 1
    }

    was_running=no
    if command -v gdbus >/dev/null 2>&1 && running_xlet; then
        was_running=yes
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
    if [ "$filtered" != "$enabled" ]; then
        gsettings set org.cinnamon enabled-applets "$filtered"
    fi

    if [ "$was_running" = yes ]; then
        attempts=0
        while [ "$attempts" -lt 5 ] && running_xlet; do
            attempts=$((attempts + 1))
            [ "$attempts" -ge 5 ] || sleep 0.2
        done
        if running_xlet; then
            echo "Cinnamon did not unload $UUID; installed files were kept" >&2
            exit 1
        fi
    fi
fi

"$SOURCE_ROOT/tools/install-translations.sh" uninstall \
    "${DESTDIR:-}$PREFIX/locale"
rm -rf -- "$TARGET_DIR"
echo "removed $TARGET_DIR"
