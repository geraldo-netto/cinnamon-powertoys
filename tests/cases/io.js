/*
 * File access, which is the layer everything that reads the machine stands on.
 *
 * It had no cases of its own. Every other file here exercised it in passing -
 * a sensor sweep reads a hundred nodes through it - and "in passing" is how a
 * layer this thin gets away with being wrong at its edges: the node that is
 * missing, the one root owns, the one amdgpu returns EBUSY for while the card
 * is asleep. Each of those is meant to come back as null rather than as an
 * exception, because the caller's answer to all three is the same and it is to
 * hide that row.
 *
 * What is checked here is the edges, and two properties that everything above
 * relies on without saying so: that a reading is a finite number or nothing,
 * and that the order two names sort in is an order.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;
const Fuzz = imports.fuzz;

const IO = Harness.requireXlet("./lib/io.js");

/* Somewhere to put files that are not in a fixture: nodes that are empty,
 * unreadable, or full of something no sysfs node would ever hold. */
function scratch(body) {
    let directory = GLib.dir_make_tmp("powertoys-io-XXXXXX");
    try {
        return body(directory);
    } finally {
        GLib.spawn_sync(null, ["rm", "-rf", directory], null, GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

function write(directory, name, contents) {
    let path = directory + "/" + name;
    GLib.file_set_contents(path, contents);
    return path;
}

/* Every path here is logical and resolved against the root, so a case that
 * wants a real directory has to be the root for the length of it. */
function rooted(directory, body) {
    IO.setRoot(directory);
    try {
        return body();
    } finally {
        IO.setRoot("");
    }
}

var cases = {};

cases["a node that is not there reads as nothing, not as an error"] = function () {
    /* The whole contract of this layer. A missing node, a root owned one and
     * a busy one are the same answer to every caller: there is nothing to
     * show, hide the row. */
    Harness.equal(IO.readString("/definitely/not/here"), null, "no such file");
    Harness.equal(IO.readNumber("/definitely/not/here"), null, "nor a number in one");
    Harness.deepEqual(IO.readWords("/definitely/not/here"), [], "nor a list");
    Harness.equal(IO.readLink("/definitely/not/here"), null, "nor a link");
    Harness.equal(IO.exists("/definitely/not/here"), false, "and it says so");
    Harness.deepEqual(IO.listDir("/definitely/not/here"), [], "an empty listing, not a throw");
};

cases["a node reads as what is in it, without the newline"] = function () {
    scratch(function (directory) {
        write(directory, "governor", "performance\n");
        write(directory, "empty", "");
        write(directory, "spaces", "  schedutil  \n\n");
        rooted(directory, function () {
            Harness.equal(IO.readString("/governor"), "performance", "trimmed");
            Harness.equal(IO.readString("/empty"), "", "an empty node is empty, and is not null");
            Harness.equal(IO.readString("/spaces"), "schedutil", "and the padding goes too");
        });
    });
};

cases["a directory that cannot be listed is not a directory"] = function () {
    scratch(function (directory) {
        write(directory, "a-file", "x");
        rooted(directory, function () {
            Harness.deepEqual(IO.listDir("/a-file"), [],
                              "a file is not a listing, and asking is not an error");
        });
    });
};

cases["the root is what every path is resolved against"] = function () {
    /* It is what lets the layers above be exercised against a captured tree
     * on a machine that has none of the hardware they were written for. */
    Harness.equal(IO.resolve("/sys/class/hwmon"), "/sys/class/hwmon", "no root, no change");
    IO.setRoot("/somewhere");
    try {
        Harness.equal(IO.resolve("/sys/class/hwmon"), "/somewhere/sys/class/hwmon", "prefixed");
    } finally {
        IO.setRoot("");
    }
    IO.setRoot(null);
    Harness.equal(IO.resolve("/sys"), "/sys", "and null is the same as none");
};

cases["a listing is in the order a person would put it in"] = function () {
    /* hwmon2 before hwmon10, which is the order the kernel numbered them in
     * and not the order they sort in as text. */
    scratch(function (directory) {
        for (let name of ["hwmon10", "hwmon2", "hwmon1", "hwmon20", "hwmon3"])
            write(directory, name, "");
        rooted(directory, function () {
            Harness.deepEqual(IO.listDir("/"),
                              ["hwmon1", "hwmon2", "hwmon3", "hwmon10", "hwmon20"],
                              "by number where they are numbered");
        });
    });
};

/* An enumerator that answers a few names and then does what a real one does
 * when the directory has gone: it raises. */
function brokenEnumerator(names) {
    let at = 0;
    return {
        closed: false,
        next_file: function () {
            if (at < names.length)
                return { get_name: () => names[at++] };
            throw new Error("No such file or directory");
        },
        close: function () {
            this.closed = true;
        },
    };
}

cases["a listing that fails half way is what it read, not a throw"] = function () {
    /*
     * A card being unbound while its hwmon entries are listed is a directory
     * that goes away under the enumerator, and this was the one call in the
     * file that let that out: the throw went up through the sensor sweep into
     * the poll timer's callback, which then returned nothing, which GLib takes
     * as SOURCE_REMOVE. One unlucky moment stopped the poll for the session.
     */
    let enumerator = brokenEnumerator(["hwmon0", "hwmon1"]);
    Harness.deepEqual(IO._drain(enumerator), ["hwmon0", "hwmon1"],
                      "what it managed before it stopped");
    Harness.equal(enumerator.closed, true, "and the handle is let go of anyway");
};

cases["a listing lets go of the handle even when closing is what fails"] = function () {
    let names = ["a", "b"];
    let at = 0;
    let asked = false;
    let enumerator = {
        next_file: () => (at < names.length ? { get_name: () => names[at++] } : null),
        close: () => { asked = true; throw new Error("cannot close"); },
    };
    Harness.deepEqual(IO._drain(enumerator), ["a", "b"], "every name");
    Harness.equal(asked, true, "and closing was asked for");
};

cases["a number is a finite number or it is nothing"] = function () {
    Harness.equal(IO.toNumber("42"), 42, "a whole one");
    Harness.equal(IO.toNumber("-40000"), -40000, "a negative one");
    Harness.equal(IO.toNumber("0"), 0, "nought is a reading");
    Harness.equal(IO.toNumber(""), null, "an empty node is not");
    Harness.equal(IO.toNumber(null), null, "nor a missing one");
    Harness.equal(IO.toNumber(undefined), null, "nor an absent one");
    Harness.equal(IO.toNumber("performance"), null, "nor a word");
    Harness.equal(IO.toNumber("40 000"), null, "nor two numbers");
    Harness.equal(IO.toNumber("Infinity"), null,
                  "and not something JavaScript will call a number when sysfs would not");
    Harness.equal(IO.toNumber("NaN"), null, "nor that");
};

cases["nothing a node can hold comes back as a number that is not one"] = function () {
    /*
     * The property every caller above leans on without saying so: a reading is
     * a finite number or it is null. lib/format.js prints whatever this hands
     * over, an alert is compared against it, and a watt figure is worked out
     * by subtracting two of them - so one NaN reaching this far is a NaN in
     * the panel and an alert that can never fire.
     */
    Fuzz.forAll({ what: "toNumber", runs: 600 },
                random => random.chance(3) ? Fuzz.value(random) : Fuzz.text(random),
                input => {
                    let value = Fuzz.answers(() => IO.toNumber(input));
                    if (value === null)
                        return;
                    if (typeof value !== "number" || !Number.isFinite(value))
                        throw new Error("answered " + String(value));
                });
};

cases["a list of words is the words, however they are spaced"] = function () {
    scratch(function (directory) {
        write(directory, "governors", "conservative ondemand   userspace\tpowersave\nperformance\n");
        write(directory, "blank", "   \n");
        /* A one letter word, because a list is words and not words of a
         * certain size: the platform profile choices are vendor words and
         * nothing promises how short one can be. */
        write(directory, "short", "a bb  c\n");
        rooted(directory, function () {
            Harness.deepEqual(IO.readWords("/governors"),
                              ["conservative", "ondemand", "userspace", "powersave", "performance"],
                              "split on whatever whitespace the driver used");
            Harness.deepEqual(IO.readWords("/blank"), [], "and nothing is no words");
            Harness.deepEqual(IO.readWords("/short"), ["a", "bb", "c"],
                              "a word of one letter is a word");
        });
    });
};

cases["a link reads as where it points"] = function () {
    scratch(function (directory) {
        write(directory, "target", "x");
        GLib.spawn_sync(null, ["ln", "-s", directory + "/target", directory + "/link"],
                        null, GLib.SpawnFlags.SEARCH_PATH, null);
        rooted(directory, function () {
            Harness.equal(IO.readLink("/link"), directory + "/target", "the target");
            Harness.equal(IO.readLink("/target"), null, "a file that is not a link points nowhere");
        });
    });
};

cases["several link targets are queried asynchronously"] = function () {
    scratch(function (directory) {
        write(directory, "target", "x");
        GLib.spawn_sync(null, ["ln", "-s", "target", directory + "/link"],
                        null, GLib.SpawnFlags.SEARCH_PATH, null);
        rooted(directory, function () {
            let values = Harness.settle(
                done => IO.readLinksAsync(["/link", "/target", "/gone"], done, 2),
                "three link queries");
            Harness.equal(values["/link"], "target", "the undecoded target is retained");
            Harness.equal(values["/target"], null, "a regular file is not a link");
            Harness.equal(values["/gone"], null, "nor is a missing path");
        });
    });
};

cases["several nodes at once answer once, with a value each"] = function () {
    /*
     * The asynchronous read the poll uses. What matters is that it answers
     * exactly once whatever the paths are - the reading assembled from it
     * counts on that - and that a node it could not read is null rather than
     * missing, so the caller cannot mistake one for the other.
     */
    scratch(function (directory) {
        write(directory, "one", "1\n");
        write(directory, "two", "2\n");
        rooted(directory, function () {
            let values = Harness.settle(done => IO.readStringsAsync(["/one", "/two", "/gone"], done),
                                        "three nodes");
            Harness.equal(values["/one"], "1", "the first");
            Harness.equal(values["/two"], "2", "the second");
            Harness.equal(values["/gone"], null, "and the one that is not there");
            Harness.equal(Object.keys(values).length, 3, "one entry per path asked for");
        });
    });
};

cases["asynchronous file setup failures retain the batch contract"] = function () {
    let fail = () => { throw new Error("file setup failed"); };
    let strings = Harness.settle(done =>
        IO.readStringsAsync(["/one", "/two"], done, 1, fail), "failed string batch");
    Harness.deepEqual(strings, { "/one": null, "/two": null },
                      "each unreadable node is represented");

    let links = Harness.settle(done =>
        IO.readLinksAsync(["/one", "/two"], done, 1, fail), "failed link batch");
    Harness.deepEqual(links, { "/one": null, "/two": null },
                      "each unreadable link is represented");

    let existing = Harness.settle(done =>
        IO.pathsExistAsync(["/one", "/two"], done, 1, fail), "failed metadata batch");
    Harness.deepEqual(existing, { "/one": false, "/two": false },
                      "each failed metadata query is false");
};

cases["asynchronous existence checks are unique and complete"] = function () {
    scratch(function (directory) {
        write(directory, "present", "x");
        rooted(directory, function () {
            let values = Harness.settle(done =>
                IO.pathsExistAsync(["/present", "/missing", "/present"], done, 1),
                "existence batch");
            Harness.deepEqual(values, { "/present": true, "/missing": false },
                              "one result per distinct path");
            let empty = Harness.settle(done => IO.pathsExistAsync([], done), "empty metadata batch");
            Harness.deepEqual(empty, {}, "an empty batch still settles");
        });
    });
};

cases["asynchronous metadata batches obey their concurrency limit"] = function () {
    let pending = [];
    let active = 0;
    let maximum = 0;
    let factory = path => ({
        query_info_async: function (attributes, flags, priority, cancellable, onDone) {
            active++;
            maximum = Math.max(maximum, active);
            pending.push(() => { active--; onDone(this, {}); });
        },
        query_info_finish: () => ({}),
    });
    let answer = null;
    IO.pathsExistAsync(["/a", "/b", "/c"], values => { answer = values; }, 1, factory);
    Harness.equal(pending.length, 1, "only the permitted query starts");
    while (pending.length > 0)
        pending.shift()();
    Harness.equal(maximum, 1, "the limit is never exceeded at its boundary");
    Harness.deepEqual(answer, { "/a": true, "/b": true, "/c": true },
                      "the queued paths still all settle");
};

cases["an asynchronous batch deadline settles once and cancels its Gio work"] = function () {
    let timeout = null;
    let removed = [];
    let cancellations = 0;
    let reply = null;
    let answers = 0;
    let value = null;
    let cancellable = { cancel: () => cancellations++ };
    let options = {
        cancellable: cancellable,
        timeoutMs: 17,
        addTimeout: (delay, callback) => {
            Harness.equal(delay, 17, "the configured bound is used");
            timeout = callback;
            return 41;
        },
        removeTimeout: id => removed.push(id),
    };
    let factory = () => ({
        load_contents_async: function (token, onDone) {
            Harness.equal(token, cancellable, "the deadline token owns the Gio request");
            reply = () => onDone(this, {});
        },
        load_contents_finish: () => [true, "too late"],
    });

    let operation = IO.readStringsAsync(["/slow", "/queued"], answer => {
        answers++;
        value = answer;
    }, 1, factory, options);
    Harness.equal(operation.active, true, "the unfinished batch is cancellable");
    Harness.equal(typeof timeout, "function", "a deadline was armed");
    timeout();

    Harness.equal(operation.active, false, "the expired batch is closed");
    Harness.equal(cancellations, 1, "its filesystem work is cancelled");
    Harness.deepEqual(value, { "/slow": null, "/queued": null },
                      "started and queued paths both receive their fallback");
    Harness.deepEqual(removed, [], "an elapsed source removes itself");
    reply();
    operation.cancel();
    Harness.equal(answers, 1, "neither a late reply nor repeated cancellation answers again");
};

cases["an asynchronous scope cancels all owned work and rejects later work"] = function () {
    let scope = new IO.AsyncScope();
    let cancelled = 0;
    let removed = [];
    let answers = [];
    let options = () => ({
        scope: scope,
        cancellable: { cancel: () => cancelled++ },
        addTimeout: () => 9,
        removeTimeout: id => removed.push(id),
    });
    let stalled = () => ({ load_contents_async: () => {} });

    IO.readStringsAsync(["/one"], value => answers.push(value), 1, stalled, options());
    IO.readStringsAsync(["/two"], value => answers.push(value), 1, stalled, options());
    scope.cancel();
    scope.cancel();

    Harness.equal(cancelled, 2, "every operation is cancelled exactly once");
    Harness.deepEqual(removed, [9, 9], "their outstanding deadlines are removed");
    Harness.deepEqual(answers, [{ "/one": null }, { "/two": null }],
                      "each owner callback is settled");

    let started = false;
    IO.readStringsAsync(["/later"], value => answers.push(value), 1,
        () => { started = true; return stalled(); }, options());
    Harness.equal(started, false, "a cancelled owner starts no new filesystem work");
    Harness.deepEqual(answers[2], { "/later": null }, "later work is rejected coherently");
    Harness.equal(cancelled, 3, "the rejected operation's token is cancelled too");
};

cases["a completed asynchronous batch disarms its deadline"] = function () {
    let removed = [];
    let cancelled = 0;
    let file = {
        load_contents_async: function (token, onDone) { onDone(this, {}); },
        load_contents_finish: () => [true, "ready\n"],
    };
    let value = Harness.settle(done => IO.readStringsAsync(["/ready"], done, 1,
        () => file, {
            cancellable: { cancel: () => cancelled++ },
            addTimeout: () => 73,
            removeTimeout: id => removed.push(id),
        }), "completed bounded read");

    Harness.deepEqual(value, { "/ready": "ready" }, "the ordinary result is retained");
    Harness.deepEqual(removed, [73], "the unused deadline is removed");
    Harness.equal(cancelled, 0, "successful work is not cancelled");
};

cases["readability metadata is queried without reading contents"] = function () {
    scratch(function (directory) {
        write(directory, "present", "x");
        rooted(directory, function () {
            Harness.equal(IO.canRead("/present"), true, "a readable node");
            Harness.equal(IO.canRead("/missing"), false, "a missing node");
        });
    });
};

cases["readability metadata batches do not sample node contents"] = function () {
    let attributes = [];
    let factory = () => ({
        query_info_async: function (requested, flags, priority, token, onDone) {
            attributes.push(requested);
            onDone(this, {});
        },
        query_info_finish: () => ({
            get_attribute_boolean: name => name === "access::can-read",
        }),
    });
    let values = Harness.settle(done =>
        IO.pathsReadableAsync(["/energy", "/power"], done, 1, factory),
        "readability metadata batch");

    Harness.deepEqual(values, { "/energy": true, "/power": true },
                      "each access answer is retained");
    Harness.deepEqual(attributes, ["access::can-read", "access::can-read"],
                      "only access metadata is requested");
};

cases["readability metadata failures are safely unreadable"] = function () {
    let factory = path => ({
        query_info_async: function (requested, flags, priority, token, onDone) {
            if (path.indexOf("setup") >= 0)
                throw new Error("cannot start metadata query");
            onDone(this, {});
        },
        query_info_finish: function () {
            if (path.indexOf("failed") >= 0)
                throw new Error("metadata vanished");
            return { get_attribute_boolean: () => false };
        },
    });
    let values = Harness.settle(done =>
        IO.pathsReadableAsync(["/unreadable", "/failed", "/setup"], done, 2, factory),
        "negative readability metadata");

    Harness.deepEqual(values, {
        "/unreadable": false,
        "/failed": false,
        "/setup": false,
    }, "denial, failed reply and failed query setup are all safe negatives");
};

function asyncDirectory(options) {
    let settings = options || {};
    let batches = (settings.batches || [[]]).slice();
    let enumerator = {
        close: function () {
            if (settings.onClose)
                settings.onClose();
        },
        next_files_async: function (count, priority, cancellable, onDone) {
            if (settings.throwNext)
                throw new Error("cannot ask for entries");
            onDone(this, {});
        },
        next_files_finish: function () {
            if (settings.failNextFinish)
                throw new Error("cannot finish entries");
            let names = batches.shift() || [];
            return names.map(name => ({ get_name: () => name }));
        },
        close_async: function (priority, cancellable, onDone) {
            if (settings.throwClose)
                throw new Error("cannot start close");
            onDone(this, {});
        },
        close_finish: function () {
            if (settings.failCloseFinish)
                throw new Error("cannot finish close");
        },
    };
    return {
        enumerate_children_async: function (attributes, flags, priority, cancellable, onDone) {
            if (settings.throwEnumerate)
                throw new Error("cannot enumerate");
            onDone(this, {});
        },
        enumerate_children_finish: function () {
            if (settings.failEnumerateFinish)
                throw new Error("cannot finish enumeration");
            return enumerator;
        },
    };
}

cases["asynchronous listings settle across every filesystem failure boundary"] = function () {
    function listing(settings, label) {
        return Harness.settle(done => IO.listDirAsync("/ignored", done,
            () => asyncDirectory(settings)), label);
    }

    Harness.deepEqual(listing({ batches: [["hwmon10", "hwmon2"], []] }, "complete listing"),
                      ["hwmon2", "hwmon10"], "successful batches are naturally sorted");
    Harness.deepEqual(listing({ throwEnumerate: true }, "enumeration setup failure"), [],
                      "a synchronous enumeration failure settles");
    Harness.deepEqual(listing({ failEnumerateFinish: true }, "enumeration reply failure"), [],
                      "a failed enumeration reply settles");
    Harness.deepEqual(listing({ throwNext: true }, "entry setup failure"), [],
                      "a synchronous entry failure closes and settles");
    Harness.deepEqual(listing({ failNextFinish: true }, "entry reply failure"), [],
                      "a failed entry reply closes and settles");
    Harness.deepEqual(listing({ throwClose: true }, "close setup failure"), [],
                      "a synchronous close failure still settles");
    Harness.deepEqual(listing({ failCloseFinish: true }, "close reply failure"), [],
                      "a failed close reply retains the listing");
    Harness.deepEqual(Harness.settle(done => IO.listDirAsync("/ignored", done,
        () => { throw new Error("no directory"); }), "file factory failure"), [],
                      "a directory factory failure settles too");
};

cases["a directory that answers with no enumerator still settles"] = function () {
    /* A provider that reports success and hands back nothing leaves the
     * listing with a handle it cannot read and nothing to close. */
    let directory = {
        enumerate_children_async: function (attributes, flags, priority, token, onDone) {
            onDone(this, {});
        },
        enumerate_children_finish: () => null,
    };
    Harness.deepEqual(Harness.settle(done => IO.listDirAsync("/empty", done, () => directory),
                                     "enumerator-less directory"), [],
                      "there is nothing to list and nothing to close");
};

cases["an asynchronous listing deadline settles an unresponsive directory"] = function () {
    let timeout = null;
    let cancelled = 0;
    let answers = 0;
    let value = null;
    let directory = {
        enumerate_children_async: function (attributes, flags, priority, token, onDone) {
            /* Deliberately never answer, like a wedged filesystem provider. */
        },
    };
    let operation = IO.listDirAsync("/slow", answer => {
        answers++;
        value = answer;
    }, () => directory, {
        cancellable: { cancel: () => cancelled++ },
        addTimeout: (delay, callback) => { timeout = callback; return 5; },
        removeTimeout: () => {},
    });

    timeout();
    operation.cancel();
    Harness.deepEqual(value, [], "a stalled listing becomes the best partial listing");
    Harness.equal(cancelled, 1, "the enumeration is cancelled");
    Harness.equal(answers, 1, "the listing settles exactly once");
};

cases["cancelling an open asynchronous listing closes its enumerator once"] = function () {
    let next = null;
    let closed = 0;
    let answers = 0;
    let directory = asyncDirectory({ onClose: () => closed++ });
    directory.enumerate_children_finish = function () {
        let handle = asyncDirectory({ onClose: () => closed++ })
            .enumerate_children_finish();
        handle.next_files_async = function (count, priority, token, onDone) {
            next = () => onDone(this, {});
        };
        return handle;
    };
    let operation = IO.listDirAsync("/open", () => answers++, () => directory,
        { addTimeout: () => 19, removeTimeout: () => {} });

    operation.cancel();
    operation.cancel();
    next();
    Harness.equal(closed, 1, "the acquired handle is closed exactly once");
    Harness.equal(answers, 1, "cancellation settles exactly once");
};

cases["a listing opened by a late cancellation reply is still closed"] = function () {
    let enumerate = null;
    let closed = 0;
    let handle = asyncDirectory({ onClose: () => closed++ })
        .enumerate_children_finish();
    let directory = {
        enumerate_children_async: function (attributes, flags, priority, token, onDone) {
            enumerate = () => onDone(this, {});
        },
        enumerate_children_finish: () => handle,
    };
    let operation = IO.listDirAsync("/late", () => {}, () => directory,
        { addTimeout: () => 23, removeTimeout: () => {} });

    operation.cancel();
    enumerate();
    Harness.equal(closed, 1, "the late handle is closed after cancellation");
};

cases["directory batches cap their open enumerators"] = function () {
    let pending = [];
    let active = 0;
    let maximum = 0;
    let factory = () => {
        let directory = asyncDirectory({ batches: [[]] });
        directory.enumerate_children_async = function (attributes, flags, priority, token, onDone) {
            active++;
            maximum = Math.max(maximum, active);
            pending.push(() => {
                active--;
                onDone(this, {});
            });
        };
        return directory;
    };
    let answer = null;
    IO.listDirsAsync(["/a", "/b", "/c"], value => { answer = value; }, 2, factory);
    Harness.equal(pending.length, 2, "only the permitted listings start");
    while (pending.length > 0)
        pending.shift()();

    Harness.equal(maximum, 2, "the directory concurrency limit is observed");
    Harness.deepEqual(answer, { "/a": [], "/b": [], "/c": [] },
                      "every directory still settles");
};

cases["asking for no nodes at all still answers"] = function () {
    /* A machine with every sensor filtered out asks for nothing, and a caller
     * that is never answered is a poll that never finishes. */
    let answered = 0;
    let values = Harness.settle(done => IO.readStringsAsync([], value => {
        answered++;
        done(value);
    }), "an empty read");
    Harness.deepEqual(values, {}, "nothing came back");
    Harness.equal(answered, 1, "and it came back once");
};

cases["the same node asked for twice is answered once"] = function () {
    /* The count is what tells it that everything is in, and a path that
     * appears twice must not answer for both or the count goes past zero
     * before the rest have landed. */
    scratch(function (directory) {
        write(directory, "one", "1\n");
        rooted(directory, function () {
            let values = Harness.settle(done => IO.readStringsAsync(["/one", "/one"], done),
                                        "the same node twice");
            Harness.equal(values["/one"], "1", "answered");
        });
    });
};

cases["bytes off the disk become text"] = function () {
    scratch(function (directory) {
        /* A label with a character that is not ASCII, which is what a vendor
         * puts in an EDID string and what pci.ids is full of. */
        write(directory, "label", "Beyerdynamic MMX 300 — 2. Generation\n");
        rooted(directory, function () {
            Harness.equal(IO.readString("/label"), "Beyerdynamic MMX 300 — 2. Generation",
                          "read back as it was written");
        });
    });
};

cases["a value that is already text is left alone"] = function () {
    /* _decode is handed whatever GLib gave back, which on some versions is a
     * string already and on others a byte array. */
    Harness.equal(IO._decode("performance"), "performance", "a string passes through");
    Harness.equal(IO._decode(new TextEncoder().encode("performance")), "performance",
                  "and bytes are decoded");
    Harness.throws(() => IO._decode([112, 101]),
                   "something that is neither is reported rather than quietly wrong");
};

cases["a name sorts against another name the same way round every time"] = function () {
    /*
     * naturalCompare is what orders the sensor list and every directory
     * listing, and Array.sort is entitled to assume its comparator is an
     * ordering. One that says a is before b and also b is before a produces a
     * different list depending on which pairs the sort happens to compare -
     * a menu whose rows move about between polls for no reason anybody could
     * describe.
     */
    let names = ["hwmon1", "hwmon10", "hwmon2", "", "0", "00", "a", "a1", "a01", "a1b",
                 "1a", "10a", "temp1_input", "temp10_input", "9", "10", "x-1", "1.5", "1_5"];

    for (let a of names) {
        Harness.equal(Math.sign(IO.naturalCompare(a, a)), 0, JSON.stringify(a) + " against itself");
        for (let b of names) {
            let there = Math.sign(IO.naturalCompare(a, b));
            let back = Math.sign(IO.naturalCompare(b, a));
            Harness.equal(there, -back,
                          JSON.stringify(a) + " and " + JSON.stringify(b) +
                          " disagree about which comes first");
        }
    }
};

cases["and the same way round for names nobody thought of"] = function () {
    /* The same claim over generated names, and transitivity with it: if a
     * comes before b and b before c, a has to come before c, or a sort of
     * three of them has no answer at all. */
    let alphabet = ["", "0", "1", "9", "10", "01", "a", "b", "_", "-", ".", "hwmon", "temp",
                    "input", "2", "20"];

    Fuzz.forAll({ what: "naturalCompare", runs: 800 }, random => {
        let name = () => {
            let out = "";
            let parts = random.below(4);
            for (let i = 0; i < parts; i++)
                out += random.pick(alphabet);
            return out;
        };
        return [name(), name(), name()];
    }, ([a, b, c]) => {
        let ab = Math.sign(Fuzz.answers(() => IO.naturalCompare(a, b)));
        let ba = Math.sign(Fuzz.answers(() => IO.naturalCompare(b, a)));
        if (ab !== -ba)
            throw new Error(JSON.stringify([a, b]) + " compares " + ab + " and " + ba);

        let bc = Math.sign(IO.naturalCompare(b, c));
        let ac = Math.sign(IO.naturalCompare(a, c));
        if (ab < 0 && bc < 0 && !(ac < 0))
            throw new Error(JSON.stringify([a, b, c]) + " is not transitive: " +
                            ab + ", " + bc + ", " + ac);
        if (ab === 0 && bc === 0 && ac !== 0)
            throw new Error(JSON.stringify([a, b, c]) + " sorts as equal in pairs and not at all " +
                            "as three: " + ac);
    });
};

cases["a number inside a name sorts as a number"] = function () {
    Harness.ok(IO.naturalCompare("hwmon2", "hwmon10") < 0, "2 before 10");
    Harness.ok(IO.naturalCompare("hwmon10", "hwmon2") > 0, "and the other way round");
    Harness.ok(IO.naturalCompare("temp1_input", "temp2_input") < 0, "in the middle of a name");
    Harness.ok(IO.naturalCompare("a", "b") < 0, "and letters are still letters");
    Harness.equal(IO.naturalCompare("hwmon2", "hwmon2"), 0, "the same name is the same name");
};
