#!/bin/sh
# Install or remove the root-owned helper and polkit action under one lock.

set -eu

ACTION=${1:-}
HELPER_SOURCE=${2:-}
HELPER_DESTINATION=${3:-}
POLICY_SOURCE=${4:-}
POLICY_DESTINATION=${5:-}
LOCK_TARGET=${6:-}

[ "$#" -eq 6 ] && [ -n "$HELPER_DESTINATION" ] &&
        [ -n "$POLICY_DESTINATION" ] && [ -n "$LOCK_TARGET" ] || {
    echo "usage: install-policy.sh install|uninstall HELPER_SOURCE HELPER_DEST POLICY_SOURCE POLICY_DEST LOCK" >&2
    exit 2
}
case "$ACTION" in
    install|uninstall) ;;
    *) echo "unknown policy transition: $ACTION" >&2; exit 2;;
esac
[ "$HELPER_DESTINATION" != "$POLICY_DESTINATION" ] || {
    echo "helper and policy destinations must be different" >&2
    exit 2
}
if [ "$ACTION" = install ]; then
    [ -f "$HELPER_SOURCE" ] || {
        echo "missing policy helper source: $HELPER_SOURCE" >&2
        exit 1
    }
    [ -f "$POLICY_SOURCE" ] || {
        echo "missing polkit action source: $POLICY_SOURCE" >&2
        exit 1
    }
fi

. "$(dirname "$0")/transition-lock.sh"
acquire_transition_lock "$LOCK_TARGET" policy

helper_directory=$(dirname "$HELPER_DESTINATION")
policy_directory=$(dirname "$POLICY_DESTINATION")

if [ "$ACTION" = uninstall ]; then
    rm -f -- "$POLICY_DESTINATION"
    rm -f -- "$HELPER_DESTINATION"
    rmdir "$helper_directory" 2>/dev/null || true
    exit 0
fi

helper_directory_existed=no
policy_directory_existed=no
[ -d "$helper_directory" ] && helper_directory_existed=yes
[ -d "$policy_directory" ] && policy_directory_existed=yes

helper_staging=
policy_staging=
helper_backup=
policy_backup=
helper_backup_ready=no
policy_backup_ready=no
helper_published=no
policy_published=no
committed=no

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e

    if [ "$committed" != yes ]; then
        # The helper is published first and restored first. Any old action
        # therefore continues to name a compatible old helper throughout the
        # rollback rather than briefly naming a missing executable.
        if [ "$helper_published" = yes ]; then
            if [ "$helper_backup_ready" = yes ]; then
                if mv -f -- "$helper_backup" "$HELPER_DESTINATION"; then
                    helper_backup=
                    helper_published=no
                else
                    echo "could not restore the previous policy helper from $helper_backup" >&2
                    status=1
                fi
            elif rm -f -- "$HELPER_DESTINATION"; then
                helper_published=no
            else
                echo "could not remove the uncommitted policy helper" >&2
                status=1
            fi
        fi
        if [ "$policy_published" = yes ]; then
            if [ "$policy_backup_ready" = yes ]; then
                if mv -f -- "$policy_backup" "$POLICY_DESTINATION"; then
                    policy_backup=
                    policy_published=no
                else
                    echo "could not restore the previous polkit action from $policy_backup" >&2
                    status=1
                fi
            elif rm -f -- "$POLICY_DESTINATION"; then
                policy_published=no
            else
                echo "could not remove the uncommitted polkit action" >&2
                status=1
            fi
        fi
    fi

    [ -n "$helper_staging" ] && rm -f -- "$helper_staging"
    [ -n "$policy_staging" ] && rm -f -- "$policy_staging"
    # A backup still associated with a published file is the only remaining
    # recovery copy after a failed rollback. Retain it and name it above.
    if [ -n "$helper_backup" ] &&
            { [ "$committed" = yes ] || [ "$helper_published" != yes ]; }; then
        rm -f -- "$helper_backup"
    fi
    if [ -n "$policy_backup" ] &&
            { [ "$committed" = yes ] || [ "$policy_published" != yes ]; }; then
        rm -f -- "$policy_backup"
    fi

    if [ "$policy_directory_existed" != yes ]; then
        rmdir "$policy_directory" 2>/dev/null || true
    fi
    if [ "$helper_directory_existed" != yes ]; then
        rmdir "$helper_directory" 2>/dev/null || true
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

install -d "$helper_directory" "$policy_directory"
helper_staging=$(mktemp "$helper_directory/.powertoys-helper.new.XXXXXX")
policy_staging=$(mktemp "$policy_directory/.powertoys-policy.new.XXXXXX")

# Both desired files are complete, validated copies before either live file is
# backed up or replaced.
install -m 0755 "$HELPER_SOURCE" "$helper_staging"
install -m 0644 "$POLICY_SOURCE" "$policy_staging"

if [ -e "$HELPER_DESTINATION" ] || [ -L "$HELPER_DESTINATION" ]; then
    helper_backup=$(mktemp "$helper_directory/.powertoys-helper.old.XXXXXX")
    rm -f -- "$helper_backup"
    cp -a -- "$HELPER_DESTINATION" "$helper_backup"
    helper_backup_ready=yes
fi
if [ -e "$POLICY_DESTINATION" ] || [ -L "$POLICY_DESTINATION" ]; then
    policy_backup=$(mktemp "$policy_directory/.powertoys-policy.old.XXXXXX")
    rm -f -- "$policy_backup"
    cp -a -- "$POLICY_DESTINATION" "$policy_backup"
    policy_backup_ready=yes
fi

# Each rename and its publication marker form one state transition with
# respect to the signal trap. A signal between the two files is handled by the
# ordinary rollback and restores the helper already published.
trap '' HUP INT TERM
mv -f -- "$helper_staging" "$HELPER_DESTINATION"
helper_staging=
helper_published=yes
trap 'exit 1' HUP INT TERM

trap '' HUP INT TERM
mv -f -- "$policy_staging" "$POLICY_DESTINATION"
policy_staging=
policy_published=yes
trap 'exit 1' HUP INT TERM

# Nothing fallible follows as part of the transaction. Cleanup removes the
# recovery copies without ever rolling back a committed pair.
committed=yes
