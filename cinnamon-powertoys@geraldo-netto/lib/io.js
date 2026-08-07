/*
 * cinnamon-powertoys - file access.
 *
 * The thinnest layer under everything that reads the machine. Each call is
 * best effort: a node that is missing, root-only or busy (amdgpu returns EBUSY
 * while the card is asleep) yields null instead of throwing, so the caller can
 * simply hide that row.
 *
 * Paths passed in here are logical, always the real ones under /sys, and are
 * resolved against a root that is empty in normal use. Pointing the root at a
 * captured tree is what lets the layers above be exercised on a machine that
 * has none of the hardware they were written for.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

let _root = "";
var ASYNC_TIMEOUT_MS = 5000;

/* A backend owns one scope and gives it to every asynchronous filesystem
 * operation it starts. Destroying the backend can then cancel the complete
 * tree of work, including operations started by discovery helpers. */
var AsyncScope = class AsyncScope {
    constructor() {
        this._operations = new Set();
        this._cancelled = false;
    }

    track(operation) {
        if (!operation?.active)
            return operation;
        if (this._cancelled)
            operation.cancel();
        else
            this._operations.add(operation);
        return operation;
    }

    release(operation) {
        this._operations.delete(operation);
    }

    cancel() {
        if (this._cancelled)
            return;
        this._cancelled = true;
        let operations = Array.from(this._operations);
        this._operations.clear();
        for (let operation of operations)
            operation.cancel();
    }
};

/* Gio cancellation alone is not a completion guarantee: a broken provider
 * may never dispatch its callback. The deadline therefore settles the public
 * callback itself and treats any later Gio answer as stale. */
function _asyncOperation(onCancel, options) {
    let configuration = options || {};
    let active = true;
    let timer = 0;
    let cancellable = configuration.cancellable || new Gio.Cancellable();
    let scope = configuration.scope || null;
    let removeTimeout = configuration.removeTimeout || (id => GLib.source_remove(id));
    let addTimeout = configuration.addTimeout || ((delay, callback) =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback));
    let timeout = Number.isFinite(configuration.timeoutMs)
        ? Math.max(1, configuration.timeoutMs) : ASYNC_TIMEOUT_MS;

    let operation = {
        get active() {
            return active;
        },
        cancellable: cancellable,
        finish: () => {
            if (!active)
                return false;
            active = false;
            if (timer !== 0) {
                removeTimeout(timer);
                timer = 0;
            }
            if (scope)
                scope.release(operation);
            return true;
        },
        cancel: () => {
            if (!operation.finish())
                return;
            try {
                cancellable.cancel();
            } catch (e) {
                /* A replacement used by tests or an old Gio may reject it. */
            }
            onCancel();
        },
    };

    if (scope)
        scope.track(operation);
    if (operation.active) {
        timer = addTimeout(timeout, () => {
            timer = 0;
            operation.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }
    return operation;
}

function _batchAsync(paths, onDone, concurrency, fallback, startOne, options) {
    let values = {};
    let unique = Array.from(new Set(paths));
    let pending = new Set(unique);
    let nextPath = 0;
    let active = 0;
    let limit = Math.max(1, concurrency || unique.length);
    let operation = _asyncOperation(() => {
        for (let path of pending)
            values[path] = fallback;
        pending.clear();
        onDone(values);
    }, options);

    let finish = () => {
        operation.finish();
        onDone(values);
    };
    let start = () => {
        while (operation.active && active < limit && nextPath < unique.length) {
            let path = unique[nextPath++];
            active++;
            startOne(path, operation.cancellable, value => {
                if (!operation.active || !pending.delete(path))
                    return;
                values[path] = value;
                active--;
                if (pending.size === 0)
                    finish();
                else
                    start();
            });
        }
    };

    if (operation.active) {
        if (pending.size === 0)
            finish();
        else
            start();
    }
    return operation;
}

function setRoot(path) {
    _root = path || "";
}

function resolve(path) {
    return _root + path;
}

function _decode(bytes) {
    if (typeof bytes === "string")
        return bytes;
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return imports.byteArray.toString(bytes);
    }
}

function readString(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(resolve(path));
        if (!ok)
            return null;
        return _decode(contents).trim();
    } catch (e) {
        return null;
    }
}

/* What a sysfs node's contents mean as a number, or null. Separate from the
 * reading so that a value fetched any other way is understood the same way. */
function toNumber(raw) {
    if (raw === null || raw === undefined || raw === "")
        return null;
    let value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function readNumber(path) {
    return toNumber(readString(path));
}

/*
 * Several nodes at once, off the calling thread.
 *
 * GLib has no asynchronous file_get_contents - the async read of a whole file
 * is Gio.File.load_contents_async, which hands the open, read and close to a
 * worker thread and calls back on the main loop. That is the difference that
 * matters here: a sysfs read is not always quick, and a temperature node on a
 * sleeping NVMe drive blocks for milliseconds while the drive is woken. In the
 * process that draws the desktop, that is dropped frames.
 *
 * The callback gets one object of path to contents, with null for anything
 * that could not be read - the same answer readString gives, since a node that
 * is missing, root-only or busy is an ordinary state here and not a failure.
 * It is called exactly once, including for an empty list.
 */
function readStringsAsync(paths, onDone, concurrency, fileFactory, options) {
    return _batchAsync(paths, onDone, concurrency, null,
        (path, cancellable, settle) => {
        try {
            let file = fileFactory ? fileFactory(resolve(path))
                                   : Gio.File.new_for_path(resolve(path));
            file.load_contents_async(cancellable, (file, result) => {
                try {
                    let [ok, contents] = file.load_contents_finish(result);
                    settle(ok ? _decode(contents).trim() : null);
                } catch (e) {
                    settle(null);
                }
            });
        } catch (e) {
            settle(null);
        }
    }, options);
}

/*
 * A node that holds a list, as the list.
 *
 * There is no empty word to filter out afterwards: readString has already
 * trimmed, so the only string that could produce one is the empty string, and
 * the guard above answers that first. The filter that used to be here could
 * not remove anything, which is a thing worth knowing rather than a thing
 * worth keeping - it read as though the split were untrustworthy.
 */
function readWords(path) {
    let raw = readString(path);
    if (!raw)
        return [];
    return raw.split(/\s+/);
}

/* The target of a symlink, undecoded: callers only ever want its basename. */
function readLink(path) {
    try {
        return GLib.file_read_link(resolve(path)) || null;
    } catch (e) {
        return null;
    }
}

/* Symlink targets in one bounded asynchronous batch. query_info_async keeps
 * resolving a sysfs class link off Cinnamon's main thread just as
 * readStringsAsync does for node contents. */
function readLinksAsync(paths, onDone, concurrency, fileFactory, options) {
    return _batchAsync(paths, onDone, concurrency, null,
        (path, cancellable, settle) => {
        try {
            let file = fileFactory ? fileFactory(resolve(path))
                                   : Gio.File.new_for_path(resolve(path));
            file.query_info_async(
                "standard::is-symlink,standard::symlink-target",
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
                    try {
                        let info = file.query_info_finish(result);
                        settle(info.get_is_symlink() ? info.get_symlink_target() : null);
                    } catch (e) {
                        settle(null);
                    }
                });
        } catch (e) {
            settle(null);
        }
    }, options);
}

/* Existence for a bounded batch, without opening any of the nodes and without
 * making the shell thread wait on sysfs metadata. */
function pathsExistAsync(paths, onDone, concurrency, fileFactory, options) {
    return _batchAsync(paths, onDone, concurrency, false,
        (path, cancellable, settle) => {
        try {
            let file = fileFactory ? fileFactory(resolve(path))
                                   : Gio.File.new_for_path(resolve(path));
            file.query_info_async(
                "standard::type", Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
                    try {
                        file.query_info_finish(result);
                        settle(true);
                    } catch (e) {
                        settle(false);
                    }
                });
        } catch (e) {
            settle(false);
        }
    }, options);
}

/* Readability for a bounded batch, without sampling the nodes themselves. */
function pathsReadableAsync(paths, onDone, concurrency, fileFactory, options) {
    return _batchAsync(paths, onDone, concurrency, false,
        (path, cancellable, settle) => {
        try {
            let file = fileFactory ? fileFactory(resolve(path))
                                   : Gio.File.new_for_path(resolve(path));
            file.query_info_async(
                "access::can-read", Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, (file, result) => {
                    try {
                        let info = file.query_info_finish(result);
                        settle(info.get_attribute_boolean("access::can-read"));
                    } catch (e) {
                        settle(false);
                    }
                });
        } catch (e) {
            settle(false);
        }
    }, options);
}

function exists(path) {
    return GLib.file_test(resolve(path), GLib.FileTest.EXISTS);
}

function isReadable(path) {
    return readString(path) !== null;
}

/* Whether this process may read a path, without reading the path itself. This
 * is for topology checks: an energy counter changes from root-only to readable
 * without changing its directory name, and sampling it just to ask would both
 * block and advance a device whose value has time semantics. */
function canRead(path) {
    try {
        let info = Gio.File.new_for_path(resolve(path)).query_info(
            "access::can-read", Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_boolean("access::can-read");
    } catch (e) {
        return false;
    }
}

/* hwmon2 must sort before hwmon10 */
function naturalCompare(a, b) {
    let re = /(\d+)/g;
    let pa = a.split(re), pb = b.split(re);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        let sa = pa[i] || "", sb = pb[i] || "";
        let na = Number(sa), nb = Number(sb);
        if (Number.isFinite(na) && Number.isFinite(nb) && sa !== "" && sb !== "") {
            if (na !== nb)
                return na - nb;
        } else if (sa !== sb) {
            return sa < sb ? -1 : 1;
        }
    }
    return 0;
}

/*
 * Everything an open enumerator has to say, and the handle closed whatever it
 * said.
 *
 * Opening was inside a try and reading was not, which left this the one call in
 * the file that could throw: next_file answers with an error of its own when
 * the directory goes away under it - a card being unbound while its hwmon
 * entries are listed is exactly that - and the throw went up through
 * SensorSet.discover into the poll timer's own callback, which then returned
 * nothing at all. GLib reads that as SOURCE_REMOVE, so one directory
 * disappearing at the wrong moment stopped the poll for the rest of the
 * session and the panel kept whatever it last held.
 *
 * What was read before it stopped is kept, because half a sweep is a sweep and
 * the next one is seconds away. The handle is closed on the way out either
 * way; it was only closed on the path that did not need it most.
 */
function _drain(enumerator) {
    let names = [];
    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
    } catch (e) {
        /* the directory went away, or the read failed; keep what came back */
    } finally {
        try {
            enumerator.close(null);
        } catch (e) {
            /* already closed, or closing is what failed */
        }
    }
    return names;
}

function listDir(path) {
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(resolve(path))
            .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return [];
    }
    return _drain(enumerator).sort(naturalCompare);
}

/*
 * The same directory listing without making Cinnamon's main loop wait for the
 * filesystem. Entries arrive in bounded batches: a machine with a crowded
 * hwmon tree yields between batches instead of monopolising the compositor.
 */
function listDirAsync(path, onDone, fileFactory, options) {
    let names = [];
    let enumerator = null;
    let closeStarted = false;
    let closeCancelled = handle => {
        if (!handle || closeStarted)
            return;
        closeStarted = true;
        try {
            handle.close(null);
        } catch (e) {
            /* already closed, or cancellation made the provider fail */
        }
        if (enumerator === handle)
            enumerator = null;
    };
    let operation = _asyncOperation(() => {
        closeCancelled(enumerator);
        names.sort(naturalCompare);
        onDone(names);
    }, options);

    let finish = () => {
        if (operation.finish()) {
            names.sort(naturalCompare);
            onDone(names);
        }
    };
    let close = handle => {
        if (!handle || closeStarted) {
            finish();
            return;
        }
        closeStarted = true;
        try {
            handle.close_async(GLib.PRIORITY_DEFAULT, operation.cancellable,
                (source, result) => {
                try {
                    source.close_finish(result);
                } catch (e) {
                    /* The listing is still useful when closing reports an error. */
                }
                if (enumerator === handle)
                    enumerator = null;
                finish();
            });
        } catch (e) {
            if (enumerator === handle)
                enumerator = null;
            finish();
        }
    };

    try {
        if (!operation.active)
            return operation;
        let directory = fileFactory ? fileFactory(resolve(path))
                                    : Gio.File.new_for_path(resolve(path));
        directory.enumerate_children_async(
            "standard::name", Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, operation.cancellable, (source, result) => {
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (e) {
                    if (operation.active)
                        finish();
                    return;
                }
                if (!operation.active) {
                    closeCancelled(enumerator);
                    return;
                }

                let next = () => {
                    try {
                        enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT,
                            operation.cancellable,
                            (files, nextResult) => {
                                if (!operation.active)
                                    return;
                                let entries;
                                try {
                                    entries = files.next_files_finish(nextResult);
                                } catch (e) {
                                    close(enumerator);
                                    return;
                                }
                                if (!entries || entries.length === 0) {
                                    close(enumerator);
                                    return;
                                }
                                for (let info of entries)
                                    names.push(info.get_name());
                                next();
                            });
                    } catch (e) {
                        close(enumerator);
                    }
                };
                next();
            });
    } catch (e) {
        finish();
    }
    return operation;
}

/* Several directory listings with one cap across their open enumerators. */
function listDirsAsync(paths, onDone, concurrency, fileFactory, options) {
    return _batchAsync(paths, onDone, concurrency, [],
        (path, cancellable, settle) => {
            let childOptions = { ...(options || {}),
                cancellable: cancellable,
            };
            listDirAsync(path, settle, fileFactory, childOptions);
        }, options);
}
