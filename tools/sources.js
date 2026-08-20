/*
 * Which of the applet's own files a run did not reach, and how much that is.
 *
 * Both gates measure less than the applet. `make coverage` can only measure
 * what a case loaded, and `make mutants` only enumerates lib/ - because
 * applet.js and the modules under ui/ build Cinnamon widgets, so neither the
 * suite's own process nor the mutation runner can load them, no case can kill
 * a mutant in them, and they never appear in an lcov at all. They are loaded,
 * in a process of their own and only where Cinnamon is installed, by
 * tools/shell-load.sh; that says they load, which is not the same as either
 * report having reached them.
 *
 * That boundary is real and this file does not move it. What it does is stop
 * the boundary being invisible: a report that lists only what it reached reads
 * as though that were the whole applet, and the omission is silent exactly
 * where the risk is. So each tool asks here what it missed and says so, with
 * the sizes, beside its own figure.
 *
 * The same question is asked one directory over, of tools/ - the coverage run
 * measures the modules it loads out of there too, and the report says which
 * of them it did not reach and whether it was allowed not to.
 *
 * The rules are pure - a listing goes in, a listing comes out - so they are
 * exercised by tests/cases/sources.js rather than only by the tools that use
 * it, one of which cannot be run from the suite at all. The one exception is
 * jsFiles at the foot of the file, which reads a directory: it is here
 * because the two tools that need the listing had written the walk twice and
 * had already come to disagree about how far down it went.
 */

/*
 * `all` is every source that exists, as { name, lines }; `reached` is the
 * names the run actually worked on. What comes back is the difference, by
 * name, in a stable order.
 *
 * Sorted here rather than by the callers: the two tools list this in their
 * output and two reports that disagree about the order of the same set read
 * as two different sets.
 */
function unreached(all, reached) {
    let seen = {};
    for (let name of reached || [])
        seen[name] = true;
    return (all || []).filter(entry => entry && !seen[entry.name])
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function totalLines(entries) {
    return (entries || []).reduce((sum, entry) => sum + (entry.lines || 0), 0);
}

/*
 * The lines a report is speaking for, as a share of the applet. Rounded the
 * same way both tools round their own percentages, so the two figures beside
 * each other are read on the same scale.
 */
function share(reachedLines, unreachedLines) {
    let total = reachedLines + unreachedLines;
    return total === 0 ? 100 : Math.round(reachedLines / total * 1000) / 10;
}

/*
 * Which of the unreached files have no business being unreached.
 *
 * The listing above is a statement about a boundary, and a statement nobody
 * checks becomes a place to hide. Every entry in it is printed under "they
 * build Cinnamon widgets and cannot be loaded here", and exactly two kinds of
 * file that is true of: applet.js, and the modules under ui/. Anything else
 * arriving in that list is a library that no case loads, printed with a
 * reason that is not its reason and counted as a known limit rather than as
 * the hole it is.
 *
 * So the caption is a rule. What comes back is the entries the caption does
 * not cover, and a tool that gets a non-empty answer has found something to
 * fail over rather than something to print.
 */
function unexpected(entries) {
    return (entries || []).filter(entry => entry &&
        entry.name !== "applet.js" && entry.name.indexOf("ui/") !== 0);
}

/* One line per file, aligned, for a tool to print under a heading of its own. */
function lines(entries) {
    return unreached(entries, []).map(entry =>
        String(entry.lines).padStart(6) + "  " + entry.name);
}

/*
 * Which of the unreached developer tools have no business being unreached.
 *
 * The same argument as `unexpected` above, one directory over. Four files
 * under tools/ are modules the suite loads into its own process - the loader
 * emulation, the tokeniser every coverage figure is worked out with, the
 * mutation plan, and this file - and the rest are programs with a shebang
 * that a run invokes as processes and that no coverage of the suite could
 * ever reach.
 *
 * Which of the two a file is is read off its first line rather than off a
 * list here, so a new module under tools/ is measured or explained from the
 * moment it exists, and a list nobody remembered to add it to cannot be the
 * reason it was neither.
 */
function unexpectedTools(entries) {
    return (entries || []).filter(entry => entry &&
        String(entry.source || "").indexOf("#!") !== 0);
}

/*
 * Every .js file under a directory, as a relative name, down as well as
 * across.
 *
 * The one function here that touches a filesystem, and it is here rather than
 * in either caller because it had been written twice: the coverage report
 * walked the tree and the mutation runner listed one level, so a module in a
 * subdirectory of lib/ was reported by one tool and enumerated by neither -
 * which is the same hole the Makefile's wildcards had, with a longer fuse. A
 * listing this whole repository's tools share cannot drift between them.
 *
 * Sorted, so the answer is a function of the tree and not of the order a
 * directory happens to be read in.
 */
function jsFiles(directory, prefix) {
    const Gio = imports.gi.Gio;
    let names = [];
    let folder = Gio.File.new_for_path(directory);
    if (!folder.query_exists(null))
        return names;
    let entries = folder.enumerate_children("standard::name,standard::type",
                                            Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = entries.next_file(null)) !== null) {
        let name = info.get_name();
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            names = names.concat(jsFiles(directory + "/" + name,
                                         (prefix || "") + name + "/"));
        } else if (name.slice(-3) === ".js") {
            names.push((prefix || "") + name);
        }
    }
    entries.close(null);
    return names.sort();
}
