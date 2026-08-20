#!/bin/sh
# Every script given here is one the shell will accept, asked one script at a
# time.
#
# `sh -n a b c` looks like it checks three scripts and checks one: the first
# operand is the script and the rest become its positional parameters. So the
# gate that read "shell ok     helper and install scripts" had only ever
# parsed the helper, and a syntax error in install.sh or in anything under
# tools/ went past it - shellcheck happened to catch those, which is why
# nobody noticed that the check beside it had stopped being one.
#
# A loop rather than a longer operand list, because the mistake was the
# operand list.
#
# Usage: shell-syntax.sh SCRIPT ...

set -eu

[ $# -gt 0 ] || {
    echo "usage: shell-syntax.sh SCRIPT ..." >&2
    exit 2
}

failures=0
for script in "$@"; do
    sh -n "$script" || failures=$((failures + 1))
done

[ "$failures" -eq 0 ] || {
    echo "shell FAIL   $failures of $# scripts are not scripts the shell accepts" >&2
    exit 1
}

echo "shell ok     $# scripts, each parsed on its own"
