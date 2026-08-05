#!/bin/sh
# Shared non-blocking lock for every transaction that mutates one applet target.

acquire_deployment_lock() {
    deployment_target=${1:-}
    [ -n "$deployment_target" ] || {
        echo "deployment lock requires a target" >&2
        return 2
    }

    if [ -n "${POWERTOYS_DEPLOYMENT_LOCK_HELD:-}" ]; then
        if [ "$POWERTOYS_DEPLOYMENT_LOCK_HELD" = "$deployment_target" ]; then
            # The top-level installer passes its held descriptor to the
            # translation publisher. Confirm it is an actual flock descriptor
            # instead of trusting an ambient environment flag on its own.
            if flock -n 9 2>/dev/null; then
                return 0
            fi
            echo "deployment lock state for $deployment_target is invalid" >&2
            return 1
        fi
        echo "deployment lock belongs to $POWERTOYS_DEPLOYMENT_LOCK_HELD, not $deployment_target" >&2
        return 1
    fi

    command -v flock >/dev/null 2>&1 || {
        echo "flock is required to change $deployment_target safely" >&2
        return 1
    }

    deployment_parent=$(dirname "$deployment_target")
    mkdir -p "$deployment_parent"
    deployment_name=$(basename "$deployment_target")
    deployment_lock_file="$deployment_parent/.${deployment_name}.deployment.lock"
    exec 9>>"$deployment_lock_file"
    if ! flock -n 9; then
        echo "another deployment operation owns $deployment_target; try again later" >&2
        return 1
    fi

    POWERTOYS_DEPLOYMENT_LOCK_HELD=$deployment_target
    export POWERTOYS_DEPLOYMENT_LOCK_HELD
}
