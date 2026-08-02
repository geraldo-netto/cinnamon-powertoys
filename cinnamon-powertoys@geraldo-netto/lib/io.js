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

function getRoot() {
    return _root;
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

function readNumber(path) {
    let raw = readString(path);
    if (raw === null || raw === "")
        return null;
    let value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function readWords(path) {
    let raw = readString(path);
    if (!raw)
        return [];
    return raw.split(/\s+/).filter(word => word.length > 0);
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

function isUserWritable(path) {
    try {
        let info = Gio.File.new_for_path(resolve(path)).query_info("access::can-write",
                                                                   Gio.FileQueryInfoFlags.NONE,
                                                                   null);
        return info.get_attribute_boolean("access::can-write");
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
