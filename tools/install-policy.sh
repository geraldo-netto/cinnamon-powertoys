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
. "$(dirname "$0")/atomic-replace.sh"

helper_directory=$(dirname "$HELPER_DESTINATION")
policy_directory=$(dirname "$POLICY_DESTINATION")

# Both files are one transaction, and the ordering between them is this
# script's own business: the executable is published first and withdrawn
# first, so the intermediate state a signal can catch is always an action
# naming no helper and never a privileged executable no action accounts for.
# Staging, backing up, publishing and rolling back either of them is
# tools/atomic-replace.sh.

uninstall_pair() {
    uninstall_committed=no
    atomic_slot helper "$HELPER_DESTINATION" "policy helper"
    atomic_slot policy "$POLICY_DESTINATION" "polkit action"

    uninstall_cleanup() {
        uninstall_status=$?
        trap - EXIT HUP INT TERM
        set +e

        if [ "$uninstall_committed" != yes ]; then
            # Restore the action first. A failed helper restoration then leaves
            # no privileged executable exposed; the action can be withdrawn
            # again to complete the safe removal.
            uninstall_policy_ready=yes
            if ! atomic_restore policy; then
                uninstall_policy_ready=no
                atomic_retain policy
                uninstall_status=1
            fi

            if atomic_is helper removed yes; then
                if atomic_is policy existed yes &&
                        [ "$uninstall_policy_ready" != yes ]; then
                    echo "the policy pair remains safely removed; helper recovery retained at $(atomic_backup_path helper)" >&2
                    atomic_retain helper
                    uninstall_status=1
                elif ! atomic_restore helper; then
                    atomic_retain helper
                    uninstall_status=1
                    # Do not leave the successfully restored (or never moved)
                    # action naming a helper that could not be restored.
                    if atomic_is policy existed yes && atomic_present policy; then
                        if atomic_rewithdraw policy; then
                            atomic_retain policy
                            echo "the policy pair was safely removed after restoration failed" >&2
                        else
                            echo "the helper is removed, but the stale polkit action could not be withdrawn" >&2
                        fi
                    fi
                fi
            fi
        fi

        atomic_release_recovery helper || uninstall_status=1
        atomic_release_recovery policy || uninstall_status=1
        if [ "$uninstall_committed" = yes ]; then
            rmdir "$helper_directory" 2>/dev/null || true
        fi
        exit "$uninstall_status"
    }
    trap uninstall_cleanup EXIT
    atomic_arm_failure_trap

    # Reserve every recovery location before moving either live file. Each
    # directory is root-only, so a removed executable retained after an
    # exceptional cleanup cannot be invoked through the old public path. The
    # trap is already armed in case the second reservation cannot be made.
    atomic_reserve helper .powertoys-helper.remove powertoys-helper
    atomic_reserve policy .powertoys-policy.remove action.policy

    # Withdraw the executable first. The brief intermediate state is an action
    # naming no helper, never an unreferenced privileged executable. Each move
    # and marker is indivisible to the signal trap; any later failure restores
    # the exact prior pair in cleanup.
    atomic_withdraw helper
    atomic_withdraw policy

    # Both public paths now represent the requested safe state. Recovery-copy
    # cleanup may still report a protected leftover, but must never roll the
    # committed removal back.
    uninstall_committed=yes
}

if [ "$ACTION" = uninstall ]; then
    uninstall_pair
    exit 0
fi

helper_directory_existed=no
policy_directory_existed=no
[ -d "$helper_directory" ] && helper_directory_existed=yes
[ -d "$policy_directory" ] && policy_directory_existed=yes

committed=no
atomic_slot helper "$HELPER_DESTINATION" "policy helper"
atomic_slot policy "$POLICY_DESTINATION" "polkit action"

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e

    if [ "$committed" != yes ]; then
        # The helper is published first and restored first. Any old action
        # therefore continues to name a compatible old helper throughout the
        # rollback rather than briefly naming a missing executable.
        atomic_rollback helper || status=1
        atomic_rollback policy || status=1
    fi

    atomic_discard helper "$committed"
    atomic_discard policy "$committed"

    if [ "$policy_directory_existed" != yes ]; then
        rmdir "$policy_directory" 2>/dev/null || true
    fi
    if [ "$helper_directory_existed" != yes ]; then
        rmdir "$helper_directory" 2>/dev/null || true
    fi
    exit "$status"
}
trap cleanup EXIT
atomic_arm_failure_trap

install -d "$helper_directory" "$policy_directory"
atomic_stage helper .powertoys-helper.new
atomic_stage policy .powertoys-policy.new

# Both desired files are complete, validated copies before either live file is
# backed up or replaced.
install -m 0755 "$HELPER_SOURCE" "$(atomic_staging helper)"
install -m 0644 "$POLICY_SOURCE" "$(atomic_staging policy)"

atomic_backup helper .powertoys-helper.old
atomic_backup policy .powertoys-policy.old

# Each rename and its publication marker form one state transition with
# respect to the signal trap. A signal between the two files is handled by the
# ordinary rollback and restores the helper already published.
atomic_publish helper
atomic_publish policy

# Nothing fallible follows as part of the transaction. Cleanup removes the
# recovery copies without ever rolling back a committed pair.
committed=yes
