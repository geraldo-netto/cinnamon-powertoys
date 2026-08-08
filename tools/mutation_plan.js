/*
 * Put the cases most likely to notice a mutated library first.
 *
 * This is an ordering hint, never a test filter. The mutation runner still
 * gives every case a chance before it calls a mutant a survivor, so a missed
 * or newly dynamic dependency can only cost time; it cannot inflate the
 * mutation score.
 */

function _requiredLibraries(source) {
    let found = [];
    let seen = {};
    let pattern = /(?:\brequire|Harness\.requireXlet)\s*\(\s*["']\.\/(lib\/[A-Za-z0-9_-]+\.js)["']\s*\)/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        if (!seen[match[1]]) {
            seen[match[1]] = true;
            found.push(match[1]);
        }
    }
    return found;
}

function _loadsLibrariesDynamically(source) {
    return /Harness\.requireXlet\s*\(\s*["']\.\/lib\/["']\s*\+/.test(source);
}

function _stem(path) {
    let name = path.slice(path.lastIndexOf("/") + 1);
    return name.substr(-3) === ".js" ? name.slice(0, -3) : name;
}

/*
 * Distance zero is the mutated library. A library that requires it is one
 * step away, and so on. Cases exercising the nearest consumer go first.
 */
function impactedCases(target, librarySources, caseSources) {
    let distance = {};
    distance[target] = 0;

    let changed = true;
    while (changed) {
        changed = false;
        for (let library in librarySources) {
            let dependencies = _requiredLibraries(librarySources[library]);
            let nearest = null;
            for (let dependency of dependencies) {
                if (distance[dependency] === undefined)
                    continue;
                let candidate = distance[dependency] + 1;
                nearest = nearest === null ? candidate : Math.min(nearest, candidate);
            }
            if (nearest !== null &&
                    (distance[library] === undefined || nearest < distance[library])) {
                distance[library] = nearest;
                changed = true;
            }
        }
    }

    let targetStem = _stem(target);
    let ranked = [];
    for (let name in caseSources) {
        let rank = null;
        if (name === targetStem)
            rank = -1;

        for (let dependency of _requiredLibraries(caseSources[name])) {
            if (distance[dependency] === undefined)
                continue;
            rank = rank === null ? distance[dependency] : Math.min(rank, distance[dependency]);
        }

        /* loading.js deliberately constructs library paths at runtime. Keep
         * any such contract case near the front without pretending to know
         * which particular path its loop will choose. */
        if (rank === null && _loadsLibrariesDynamically(caseSources[name]))
            rank = 1000;

        if (rank !== null)
            ranked.push({ name: name, rank: rank });
    }

    ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return ranked.map(entry => entry.name);
}

/* Stable ordering even on the oldest supported JavaScript engine. Unknown
 * names are harmless and ignored. */
function prioritize(items, first) {
    let rank = {};
    for (let i = 0; i < first.length; i++) {
        if (rank[first[i]] === undefined)
            rank[first[i]] = i;
    }

    return items.map((item, index) => ({
        item: item,
        index: index,
        rank: rank[item] === undefined ? first.length : rank[item],
    })).sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(entry => entry.item);
}
