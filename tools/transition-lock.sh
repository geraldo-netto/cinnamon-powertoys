#!/bin/sh
# Blocking lock for fixed system-file transitions and staged package roots.

acquire_transition_lock() {
    transition_lock_target=${1:-}
    transition_lock_name=${2:-system}
    [ -n "$transition_lock_target" ] || {
        echo "$transition_lock_name transition lock requires a target" >&2
        return 2
    }
    command -v flock >/dev/null 2>&1 || {
        echo "the flock command required for $transition_lock_name transitions is unavailable" >&2
        return 1
    }

    if [ -d "$transition_lock_target" ]; then
        exec 8<"$transition_lock_target" || {
            echo "cannot open $transition_lock_name transition lock: $transition_lock_target" >&2
            return 1
        }
    else
        transition_lock_directory=$(dirname "$transition_lock_target")
        [ -d "$transition_lock_directory" ] ||
            install -d -m 0755 "$transition_lock_directory"
        umask 022
        exec 8>>"$transition_lock_target" || {
            echo "cannot open $transition_lock_name transition lock: $transition_lock_target" >&2
            return 1
        }
    fi
    flock -x 8 || {
        echo "cannot acquire $transition_lock_name transition lock: $transition_lock_target" >&2
        return 1
    }
}
