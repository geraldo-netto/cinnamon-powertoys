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
function readStringsAsync(paths, onDone) {
    let values = {};
    let outstanding = paths.length;

    if (outstanding === 0) {
        onDone(values);
        return;
    }

    for (let path of paths) {
        let settle = contents => {
            values[path] = contents;
            outstanding--;
            if (outstanding === 0)
                onDone(values);
        };

        try {
            Gio.File.new_for_path(resolve(path)).load_contents_async(null, (file, result) => {
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
    }
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

function exists(path) {
    return GLib.file_test(resolve(path), GLib.FileTest.EXISTS);
}

function isReadable(path) {
    return readString(path) !== null;
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

function listDir(path) {
    let names = [];
    let enumerator;
    try {
        enumerator = Gio.File.new_for_path(resolve(path))
            .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return names;
    }
    let info;
    while ((info = enumerator.next_file(null)) !== null)
        names.push(info.get_name());
    enumerator.close(null);
    return names.sort(naturalCompare);
}
