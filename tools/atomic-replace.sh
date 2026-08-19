#!/bin/sh
# Stage, back up, publish and roll back one system file, per named slot.
#
# Installing a root-owned file is always the same transaction: write the new
# copy beside the live one, keep the old one where it can be put back, swap
# them inside a window no signal can interrupt, and on any failure leave the
# directory exactly as it was found. Removing one is the same transaction read
# backwards. That reasoning was written out three times - twice in
# install-policy.sh and once in rapl-access.sh - and every correction to it had
# to be made, correctly, in each copy.
#
# A slot is one file under transition, named by the caller (`helper`, `policy`,
# `rule`). Its state lives in `atomic_<slot>_<field>` variables, so a script can
# hold several slots at once and still express its own ordering - which is the
# part that genuinely differs between transitions and stays with the caller.
#
# Every message names the slot's label, which is what the user reads: "policy
# helper", "polkit action", "RAPL rule".

# The two signal states of a transition. A publication and the marker that says
# it happened have to be indivisible: a signal in between would leave cleanup
# rolling back a file it thinks is unpublished, or leaving one it thinks is not.
atomic_arm_failure_trap() {
    trap 'exit 1' HUP INT TERM
}

atomic_hold_signals() {
    trap '' HUP INT TERM
}

_atomic_set() {
    eval "atomic_${1}_${2}=\$3"
}

_atomic_get() {
    eval "printf '%s' \"\${atomic_${1}_${2}-}\""
}

# slot destination label - declare a slot and record whether the live file is
# already there. Call it before arming the cleanup trap, so cleanup never reads
# a slot that does not exist yet.
atomic_slot() {
    _atomic_set "$1" destination "$2"
    _atomic_set "$1" label "$3"
    _atomic_set "$1" directory "$(dirname "$2")"
    _atomic_set "$1" staging ""
    _atomic_set "$1" backup ""
    _atomic_set "$1" backup_ready no
    _atomic_set "$1" published no
    _atomic_set "$1" removed no
    _atomic_set "$1" recovery ""
    _atomic_set "$1" retain no
    if [ -e "$2" ] || [ -L "$2" ]; then
        _atomic_set "$1" existed yes
    else
        _atomic_set "$1" existed no
    fi
}

# slot field value - the state test callers order themselves by.
atomic_is() {
    [ "$(_atomic_get "$1" "$2")" = "$3" ]
}

atomic_staging() {
    _atomic_get "$1" staging
}

atomic_backup_path() {
    _atomic_get "$1" backup
}

atomic_destination() {
    _atomic_get "$1" destination
}

# slot - whether something stands at the public path right now.
atomic_present() {
    _atomic_destination=$(_atomic_get "$1" destination)
    [ -e "$_atomic_destination" ] || [ -L "$_atomic_destination" ]
}

# slot prefix - reserve the staging name beside the live file, so publication
# is a rename within one directory and never a copy across filesystems. The
# caller writes the content; nothing is visible under the public name yet.
atomic_stage() {
    _atomic_staging=$(mktemp "$(_atomic_get "$1" directory)/$2.XXXXXX")
    _atomic_set "$1" staging "$_atomic_staging"
}

# slot prefix - copy the live file aside so a failure has something to restore.
atomic_backup() {
    atomic_is "$1" existed yes || return 0
    _atomic_backup=$(mktemp "$(_atomic_get "$1" directory)/$2.XXXXXX")
    rm -f -- "$_atomic_backup"
    cp -a -- "$(_atomic_get "$1" destination)" "$_atomic_backup"
    _atomic_set "$1" backup "$_atomic_backup"
    _atomic_set "$1" backup_ready yes
}

# slot - the staged file becomes the live file, indivisibly to the signal trap.
atomic_publish() {
    atomic_hold_signals
    mv -f -- "$(_atomic_get "$1" staging)" "$(_atomic_get "$1" destination)"
    _atomic_set "$1" staging ""
    _atomic_set "$1" published yes
    atomic_arm_failure_trap
}

# slot prefix basename - a root-only directory to move a removed file into.
# Reserving it before anything is moved means a removal cannot fail halfway for
# want of somewhere to put what it took away, and a retained privileged
# executable cannot be reached through its old public path.
atomic_reserve() {
    atomic_is "$1" existed yes || return 0
    _atomic_recovery=$(mktemp -d "$(_atomic_get "$1" directory)/$2.XXXXXX")
    chmod 0700 "$_atomic_recovery"
    _atomic_set "$1" recovery "$_atomic_recovery"
    _atomic_set "$1" backup "$_atomic_recovery/$3"
}

# The mover's own exit status is the transition's: a caller running under
# set -e exits with what mv said, which is what the operator is shown.
_atomic_move_out() {
    mv -- "$(_atomic_get "$1" destination)" "$(_atomic_get "$1" backup)" || return $?
    _atomic_set "$1" removed yes
}

# slot - take the live file out of the public path, indivisibly to the trap.
atomic_withdraw() {
    atomic_is "$1" existed yes || return 0
    atomic_hold_signals
    _atomic_move_out "$1"
    atomic_arm_failure_trap
}

# slot - take it out again from inside cleanup, where the traps are already
# gone and a failure is reported rather than fatal.
atomic_rewithdraw() {
    [ -n "$(atomic_backup_path "$1")" ] || return 1
    _atomic_move_out "$1"
}

# slot - put a withdrawn file back. Nonzero, and said out loud, when it cannot
# be: the caller decides what a half-undone removal should become.
atomic_restore() {
    atomic_is "$1" removed yes || return 0
    if mv -- "$(atomic_backup_path "$1")" "$(_atomic_get "$1" destination)"; then
        _atomic_set "$1" removed no
        return 0
    fi
    echo "could not restore the previous $(_atomic_get "$1" label) from $(atomic_backup_path "$1")" >&2
    return 1
}

# slot - undo a publication: the old file back where it was, or the new one
# taken away where there was nothing before.
atomic_rollback() {
    atomic_is "$1" published yes || return 0
    if atomic_is "$1" backup_ready yes; then
        if mv -f -- "$(atomic_backup_path "$1")" "$(_atomic_get "$1" destination)"; then
            _atomic_set "$1" backup ""
            _atomic_set "$1" published no
            return 0
        fi
        echo "could not restore the previous $(_atomic_get "$1" label) from $(atomic_backup_path "$1")" >&2
        return 1
    fi
    if rm -f -- "$(_atomic_get "$1" destination)"; then
        _atomic_set "$1" published no
        return 0
    fi
    echo "could not remove the uncommitted $(_atomic_get "$1" label)" >&2
    return 1
}

# slot - this slot's recovery copy is the only one left; keep it and name it.
atomic_retain() {
    _atomic_set "$1" retain yes
}

# slot committed - drop what the transaction no longer needs. A backup still
# associated with a published file is the last recovery copy there is after a
# rollback that failed, so it is kept unless the transaction committed.
atomic_discard() {
    _atomic_staging=$(atomic_staging "$1")
    if [ -n "$_atomic_staging" ]; then
        rm -f -- "$_atomic_staging"
        _atomic_set "$1" staging ""
    fi
    _atomic_backup=$(atomic_backup_path "$1")
    if [ -n "$_atomic_backup" ] &&
            { [ "$2" = yes ] || ! atomic_is "$1" published yes; }; then
        rm -f -- "$_atomic_backup"
        _atomic_set "$1" backup ""
    fi
}

# slot - remove the protected directory a withdrawn file was kept in, unless it
# was retained. Nonzero, and said out loud, when it outlives the transition.
atomic_release_recovery() {
    atomic_is "$1" retain yes && return 0
    _atomic_recovery=$(_atomic_get "$1" recovery)
    [ -n "$_atomic_recovery" ] || return 0
    if rm -rf -- "$_atomic_recovery"; then
        _atomic_set "$1" recovery ""
        return 0
    fi
    echo "$(_atomic_get "$1" label) recovery remains in protected directory $_atomic_recovery" >&2
    return 1
}
