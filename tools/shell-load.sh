#!/bin/sh
# Evaluate applet.js and every ui/ module, in a real cjs, against a real
# Cinnamon.
#
# Everything else in this repository says these five files cannot be loaded
# outside the shell, and holds them to text: a regular expression over
# applet.js instead of a call, a source string searched for a method name. A
# parse check says the engine accepts the file and the scope check says every
# name in it exists, and between them they still let through everything that
# only happens when the module body actually runs - a class whose superclass
# expression is undefined, a top level `const` reading a library export that
# was renamed, a require of a file that was moved.
#
# That is not a property of the files. It is a property of the environment
# they were being loaded in: the interpreter is the same cjs Cinnamon runs,
# and Cinnamon's own JavaScript and typelibs are ordinary files on any machine
# with Cinnamon installed. What was missing was the search paths that let cjs
# find them, which cinnamon's own launcher sets and a bare `cjs` does not - the
# private St and Meta typelibs, the libraries they name, and /usr/share/
# cinnamon/js.
#
# So this finds them and hands the rest to tools/shell-load.js. Exit 0 is
# loaded, 1 is a load failure, and 2 is a machine with no Cinnamon on it,
# which the caller reports as a skip rather than as an answer.

set -eu

TOOLS=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$TOOLS/.." && pwd)
UUID=cinnamon-powertoys@geraldo-netto
CINNAMON_JS=${POWERTOYS_CINNAMON_JS:-/usr/share/cinnamon/js}
# The copy under test, which is the repository's own unless something points
# this elsewhere - the same variable the test harness reads.
XLET_DIR=${POWERTOYS_XLET_DIR:-$ROOT/files/$UUID}

# The two private directories a Cinnamon session runs with on its library and
# typelib paths. Named by the file that has to be in them rather than by the
# distribution's directory layout, because the layout is what differs between
# distributions and the file is what cjs is going to ask for.
directory_holding() {
    for candidate in /usr/lib/*/cinnamon /usr/lib/cinnamon /usr/lib64/cinnamon \
                     /usr/lib/*/muffin /usr/lib/muffin /usr/lib64/muffin; do
        if [ -f "$candidate/$1" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

unavailable() {
    echo "shell skip   $*"
    exit 2
}

command -v cjs >/dev/null 2>&1 || unavailable "cjs is not installed"
[ -d "$CINNAMON_JS/ui" ] || unavailable "no Cinnamon JavaScript at $CINNAMON_JS"
st_dir=$(directory_holding St-1.0.typelib) || unavailable "no St typelib installed"
meta_dir=$(directory_holding Meta-0.typelib) || unavailable "no Meta typelib installed"

GI_TYPELIB_PATH="$st_dir:$meta_dir${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
LD_LIBRARY_PATH="$st_dir:$meta_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GI_TYPELIB_PATH LD_LIBRARY_PATH

exec cjs "$TOOLS/shell-load.js" "$XLET_DIR" "$CINNAMON_JS"
