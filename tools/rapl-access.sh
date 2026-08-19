#!/bin/sh
# Apply or remove the RAPL udev rule without separating persistent and live state.

set -eu

ACTION=${1:-}
SOURCE=${2:-}
DESTINATION=${3:-}
GROUP=${4:-}
LOCK_TARGET=${5:-}
POWERCAP_ROOT=${POWERTOYS_POWERCAP_ROOT:-/sys/class/powercap}

[ "$#" -eq 5 ] && { [ "$ACTION" = install ] || [ "$ACTION" = uninstall ]; } &&
        [ -n "$LOCK_TARGET" ] || {
    echo "usage: rapl-access.sh install|uninstall SOURCE DESTINATION GROUP LOCK" >&2
    exit 2
}

. "$(dirname "$0")/transition-lock.sh"
acquire_transition_lock "$LOCK_TARGET" RAPL

reload_rules() {
    udevadm control --reload
}

trigger_powercap() {
    udevadm trigger --subsystem-match=powercap
}

reset_live_permissions() {
    reset_status=0
    for counter in "$POWERCAP_ROOT"/*-rapl:*/energy_uj; do
        [ -e "$counter" ] || continue
        chgrp root "$counter" || reset_status=1
        chmod 0400 "$counter" || reset_status=1
    done
    return "$reset_status"
}

install_rule() {
    [ -f "$SOURCE" ] || {
        echo "missing RAPL rule source: $SOURCE" >&2
        return 1
    }
    case "$GROUP" in
        ""|-*|*[!A-Za-z0-9_-]*)
            echo "invalid RAPL group: $GROUP" >&2
            return 1;;
        *[!0-9]*) :;;
        *)
            # chgrp reads an all-digit operand as a gid, so `0` would hand the
            # counters back to root and report success.
            echo "name the RAPL group, not its id: $GROUP" >&2
            return 1;;
    esac

    # A rule naming a group that does not exist fails at every event, and the
    # user sees only a missing package-power row after a successful install.
    # Staging into a DESTDIR is for another machine's accounts, so not there.
    if [ -z "${DESTDIR:-}" ] && command -v getent >/dev/null 2>&1; then
        getent group "$GROUP" >/dev/null || {
            echo "no such group: $GROUP" >&2
            return 1
        }
    fi

    # udev does no PATH lookup for RUN+=, so the rule has to name both commands
    # absolutely, and where they live differs between distributions.
    chgrp_path=$(command -v chgrp || echo "")
    chmod_path=$(command -v chmod || echo "")
    for resolved in "$chgrp_path" "$chmod_path"; do
        case "$resolved" in
            /*) :;;
            *)
                echo "chgrp and chmod must both be present at an absolute path" >&2
                return 1;;
        esac
    done

    directory=$(dirname "$DESTINATION")
    install -d "$directory"
    staging=$(mktemp "$directory/.rapl-rule.new.XXXXXX")
    backup=
    backup_ready=no
    published=no
    committed=no

    install_cleanup() {
        install_status=$?
        trap - EXIT HUP INT TERM
        set +e

        if [ "$committed" != yes ] && [ "$published" = yes ]; then
            if [ "$backup_ready" = yes ]; then
                if ! mv -f -- "$backup" "$DESTINATION"; then
                    echo "could not restore the previous RAPL rule from $backup" >&2
                    install_status=1
                else
                    backup=
                fi
            else
                rm -f -- "$DESTINATION" || install_status=1
            fi

            if [ -z "${DESTDIR:-}" ]; then
                reload_rules || install_status=1
                reset_live_permissions || install_status=1
                trigger_powercap || install_status=1
            fi
        fi

        [ -n "$staging" ] && rm -f -- "$staging"
        [ -n "$backup" ] && rm -f -- "$backup"
        exit "$install_status"
    }
    trap install_cleanup EXIT
    trap 'exit 1' HUP INT TERM

    sed -e "s/@GROUP@/$GROUP/g" \
        -e "s|@CHGRP@|$chgrp_path|g" \
        -e "s|@CHMOD@|$chmod_path|g" "$SOURCE" > "$staging"
    chmod 0644 "$staging"
    if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
        backup=$(mktemp "$directory/.rapl-rule.old.XXXXXX")
        cp -p -- "$DESTINATION" "$backup"
        backup_ready=yes
    fi
    # Keep publication and its rollback state indivisible to the signal trap.
    # Otherwise cleanup can discard the backup while the new rule is already
    # visible but `published` still says it is not.
    trap '' HUP INT TERM
    mv -f -- "$staging" "$DESTINATION"
    staging=
    published=yes
    trap 'exit 1' HUP INT TERM

    if [ -z "${DESTDIR:-}" ]; then
        reload_rules
        trigger_powercap
    fi

    committed=yes
    [ -n "$backup" ] && rm -f -- "$backup"
    backup=
    trap - EXIT HUP INT TERM
}

uninstall_rule() {
    directory=$(dirname "$DESTINATION")
    backup=
    finished=no

    uninstall_cleanup() {
        uninstall_status=$?
        trap - EXIT HUP INT TERM
        set +e
        if [ "$finished" != yes ] && [ -z "${DESTDIR:-}" ]; then
            # Security wins over a partial udev transition: even on failure or
            # interruption, try every step that can revoke the live grant.
            reload_rules || uninstall_status=1
            reset_live_permissions || uninstall_status=1
            trigger_powercap || uninstall_status=1
        fi
        [ -n "$backup" ] && rm -f -- "$backup"
        exit "$uninstall_status"
    }
    trap uninstall_cleanup EXIT
    trap 'exit 1' HUP INT TERM

    if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then
        backup=$(mktemp "$directory/.rapl-rule.removed.XXXXXX")
        rm -f -- "$backup"
        mv -- "$DESTINATION" "$backup"
    fi

    if [ -n "${DESTDIR:-}" ]; then
        finished=yes
    else
        transition_status=0
        reload_rules || transition_status=1
        reset_live_permissions || transition_status=1
        trigger_powercap || transition_status=1
        finished=yes
        if [ "$transition_status" -ne 0 ]; then
            echo "RAPL rule removed, but live udev permissions could not be fully reapplied" >&2
            return "$transition_status"
        fi
    fi

    [ -n "$backup" ] && rm -f -- "$backup"
    backup=
    trap - EXIT HUP INT TERM
}

if [ "$ACTION" = install ]; then
    install_rule
else
    uninstall_rule
fi
