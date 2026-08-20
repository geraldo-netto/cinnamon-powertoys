/*
 * Everything the applet builds for its life on the panel is let go of when it
 * leaves.
 *
 * _teardown is a written-out list: one line per resource, naming the field it
 * lives in. The list is correct, and nothing was holding it to what the
 * applet actually builds - so a backend added to _buildBackends and not added
 * there leaves a D-Bus proxy, its name watch and its signal handlers alive
 * for the rest of the session, and the applet the user removed goes on
 * answering. Nothing fails; the desktop just carries it.
 *
 * The applet cannot be constructed outside Cinnamon, so this reads the source,
 * as the other applet-level cases do. What it reads is derived on both sides:
 * the fields out of the two methods that establish what the applet owns, and
 * whether a thing needs releasing at all out of the class itself.
 *
 * Scope is those two methods on purpose. What _createMenu builds lives and
 * dies with the menu rather than with the applet, and _destroyMenu owns that -
 * which _teardown calls.
 */

const Harness = imports.harness;

const BUILDERS = ["_buildState", "_buildBackends"];

/* One method of the applet class, from its signature to the closing brace at
 * the same indentation. */
function methodBody(source, name) {
    let pattern = new RegExp("\\n    " + name + "\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}\\n");
    let match = pattern.exec(source);
    Harness.ok(match !== null, name + " is present in applet.js");
    return match[1];
}

/* `const Poll = require("./lib/poll.js")` - the alias and what it stands for. */
function requiredModules(source) {
    let modules = {};
    let pattern = /(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\("([^"]+)"\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null)
        modules[match[1]] = match[2];
    return modules;
}

/*
 * What the applet builds and keeps: `this._x = new Alias.Klass(...)`, and
 * `this._x = this._backends.factory(...)`. A field written through - the
 * backlight bag is filled one control at a time - counts as its root, which
 * is the thing _teardown has to know about.
 */
function built(body) {
    let fields = [];
    let pattern = /this\.(_[A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?\s*=\s*(?:new ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(|this\._backends\.([A-Za-z_$][\w$]*)\s*\()/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
        fields.push({ field: match[1], alias: match[2], klass: match[3],
                      factory: match[4] });
    }
    return fields;
}

/*
 * Whether an object of this class has anything to let go of.
 *
 * Asked of the class rather than assumed: lib/alerts.js and
 * lib/pending-profile.js are decisions with state in them and nothing else,
 * and requiring a line in _teardown for those would be requiring noise. A
 * backend is not asked - a backend is a daemon connection, a spawn or a file
 * watch by construction, and the one that turns out to hold nothing today
 * still must not be the reason the next one is forgotten.
 */
function releasable(module, klass) {
    let exported = module[klass];
    if (!exported || !exported.prototype)
        return false;
    return Object.getOwnPropertyNames(exported.prototype)
        .some(name => /^(destroy|release|cancel|finalize)$/.test(name));
}

/*
 * Whether _teardown lets go of a field, directly or through one call.
 *
 * One level, because that is how the scroll timer is released: _teardown
 * calls _cancelPendingScroll, and that is the method that knows the field.
 * Deeper than one would stop being a statement about _teardown.
 */
function releasedBy(source, teardown, field) {
    if (teardown.indexOf("this." + field) >= 0 ||
        teardown.indexOf('"' + field + '"') >= 0)
        return true;
    let calls = /this\.(_[A-Za-z0-9]+)\(/g;
    let match;
    while ((match = calls.exec(teardown)) !== null) {
        let called = new RegExp("\\n    " + match[1] + "\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}\\n")
            .exec(source);
        if (called && called[1].indexOf("this." + field) >= 0)
            return true;
    }
    return false;
}

var cases = {};

cases["everything the applet builds is let go of when it leaves the panel"] = function () {
    let source = Harness.shellSource();
    let modules = requiredModules(source);
    let teardown = methodBody(source, "_teardown");
    let leaked = [];
    let checked = 0;
    let backends = 0;

    for (let builder of BUILDERS) {
        for (let entry of built(methodBody(source, builder))) {
            if (entry.factory) {
                backends++;
                checked++;
                if (!releasedBy(source, teardown, entry.field)) {
                    leaked.push(entry.field + ", from this._backends." + entry.factory +
                                "(), is built in " + builder + " and never released");
                }
                continue;
            }
            let path = modules[entry.alias];
            Harness.ok(path !== undefined,
                       entry.alias + " is required by applet.js");
            if (path.indexOf("./lib/") !== 0)
                continue;
            let module = Harness.requireXlet(path);
            if (!releasable(module, entry.klass))
                continue;
            checked++;
            if (!releasedBy(source, teardown, entry.field)) {
                leaked.push(entry.field + ", a " + entry.alias + "." + entry.klass +
                            " with something to let go of, is never released");
            }
        }
    }

    Harness.deepEqual(leaked, [],
                      "what an applet does not release outlives the applet");
    Harness.ok(backends > 5, "only " + backends + " backends found, which is too few");
    Harness.ok(checked > 8, "only " + checked + " resources checked, which is too few");
};

cases["a release that throws does not strand the ones after it"] = function () {
    /* The property the whole list rests on. Every line of it runs whatever
     * the line before it did, or the first backend that fails to shut down
     * keeps every later one alive - which is the failure mode a teardown
     * exists to prevent, arriving through the teardown itself. */
    let teardown = methodBody(Harness.shellSource(), "_teardown");
    let helper = /let release = \([^)]*\) => \{([\s\S]*?)\n        \};/.exec(teardown);
    Harness.ok(helper !== null, "the releases go through one helper");
    Harness.ok(helper[1].indexOf("try {") >= 0 && helper[1].indexOf("catch") >= 0,
               "which contains what one release throws");
    Harness.ok(helper[1].indexOf("Log.error") >= 0,
               "and says so rather than swallowing it");

    /*
     * A statement of _teardown's own - eight spaces in, since anything deeper
     * is already inside one of the helper's callbacks - that lets go of a
     * field without going through the helper. It was written as "any line
     * with .destroy() on it that does not also say release(", which passed
     * two ways it should not have: `this._hotkeys.release()` only because
     * "release()" happens to contain the text "release(", and
     * `this._profileSelection.release()` because the vocabulary here was
     * destroy and finalize while releasable() above - the function that
     * decides what counts as having something to let go of - has always
     * called it destroy, release, cancel or finalize. The two now agree, and
     * what identifies an unguarded line is where it sits rather than what
     * text it happens to contain.
     */
    let direct = teardown.split("\n").filter(line =>
        /^ {8}this\.[\w?.[\]"]*\.(destroy|finalize|release|cancel)\(\)/.test(line));
    Harness.deepEqual(direct, [],
                      "every release goes through the helper that contains a failure");
};
