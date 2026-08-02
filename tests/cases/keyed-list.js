/*
 * Menu rows that follow a list of values.
 *
 * The one thing in this applet that decides rather than draws: whether a
 * section is torn down and rebuilt, or the rows already in it handed the new
 * values. Getting that wrong either way is visible - rebuilding on every poll
 * drops whatever the pointer is over and makes the menu flicker, and not
 * rebuilding when the set has really changed leaves rows describing things
 * that are no longer there.
 *
 * A section here is not a menu. It is two methods and a list of what it was
 * told, which is all this class ever asks of one.
 */

const Harness = imports.harness;

const KeyedList = Harness.requireXlet("./lib/keyed-list.js");

/* Somewhere to put rows, that records what was done to it. */
function section() {
    let stub = {
        rows: [],
        clears: 0,
        removeAll: function () {
            stub.clears++;
            stub.rows = [];
        },
        addMenuItem: function (item) {
            stub.rows.push(item);
        },
    };
    return stub;
}

/* A list over that section whose rows are plain objects, so a rebuild can be
 * told from an update by identity. */
function listOver(into) {
    let created = [];
    let updated = [];
    let list = new KeyedList.KeyedList(
        into,
        entry => {
            let row = { key: entry.key, value: entry.value };
            created.push(row);
            return row;
        },
        (row, entry) => {
            updated.push([entry.key, entry.value]);
            if (row)
                row.value = entry.value;
        });
    list.created = created;
    list.updated = updated;
    return list;
}

function entries() {
    return Array.prototype.slice.call(arguments).map(key => ({ key: key, value: key + "!" }));
}

var cases = {};

cases["the first sync builds the rows"] = function () {
    let into = section();
    let list = listOver(into);
    list.sync(entries("a", "b"));

    Harness.equal(into.rows.length, 2, "one row per entry");
    Harness.deepEqual(into.rows.map(row => row.key), ["a", "b"], "in the order given");
    Harness.equal(into.clears, 1, "the section was emptied first");
};

cases["the same keys again update in place"] = function () {
    /* The whole point: rebuilding on every poll drops what the pointer is over
     * and makes the menu flicker. */
    let into = section();
    let list = listOver(into);
    list.sync(entries("a", "b"));
    let first = into.rows.slice();

    list.sync([{ key: "a", value: "changed" }, { key: "b", value: "b!" }]);
    Harness.equal(into.clears, 1, "nothing was torn down");
    Harness.deepEqual(into.rows, first, "the very same row objects are still there");
    Harness.equal(first[0].value, "changed", "and they were handed the new values");
};

cases["a changed set of keys rebuilds"] = function () {
    let into = section();
    let list = listOver(into);
    list.sync(entries("a", "b"));
    list.sync(entries("a", "b", "c"));

    Harness.equal(into.clears, 2, "torn down once more");
    Harness.deepEqual(into.rows.map(row => row.key), ["a", "b", "c"], "and built again");
};

cases["reordering the same keys is a change"] = function () {
    /* The rows are added in the order they arrive, so the order is part of
     * what the section is showing. */
    let into = section();
    let list = listOver(into);
    list.sync(entries("a", "b"));
    list.sync(entries("b", "a"));
    Harness.equal(into.clears, 2, "rebuilt");
    Harness.deepEqual(into.rows.map(row => row.key), ["b", "a"], "the other way round");
};

cases["emptying the list clears the section"] = function () {
    let into = section();
    let list = listOver(into);
    list.sync(entries("a", "b"));
    list.sync([]);
    Harness.deepEqual(into.rows, [], "nothing left");
    Harness.deepEqual(list.items, [], "and nothing claimed");
};

cases["two different sets of keys never read as one"] = function () {
    /*
     * The reason the signature counts each key's length in front of it. These
     * keys are device paths, sensor ids and profile names, and none of them
     * promises to avoid whatever separator a simpler signature would join on -
     * a set that had really changed would then read as unchanged, and the rows
     * would go on describing devices that are no longer there.
     */
    let pairs = [
        [["ab", "c"], ["a", "bc"]],
        [["a:b"], ["a", "b"]],
        [["1:a"], ["a"]],
        [["", "ab"], ["ab", ""]],
        [["a", ""], ["a"]],
    ];
    let list = listOver(section());
    for (let [left, right] of pairs) {
        let a = list._signature(left.map(key => ({ key: key })));
        let b = list._signature(right.map(key => ({ key: key })));
        Harness.ok(a !== b, "[" + left.join("|") + "] and [" + right.join("|") +
                            "] both signed as " + a);
    }
};

cases["a colliding pair really would leave the rows alone"] = function () {
    /* The same claim from the other end: through sync, so it is the behaviour
     * being asserted and not just the string. */
    let into = section();
    let list = listOver(into);
    list.sync(entries("ab", "c"));
    list.sync(entries("a", "bc"));
    Harness.equal(into.clears, 2, "the second set was recognised as a different set");
    Harness.deepEqual(into.rows.map(row => row.key), ["a", "bc"], "and drawn");
};

cases["a key that is not a string is still told apart"] = function () {
    /* Sensor ids and charge limits both come through here, and one of those
     * is a number. */
    let list = listOver(section());
    let a = list._signature([{ key: 60 }, { key: 70 }]);
    let b = list._signature([{ key: 6070 }]);
    Harness.ok(a !== b, "60 and 70 is not 6070");
};

cases["the rows are what it claims to hold"] = function () {
    let list = listOver(section());
    list.sync(entries("a", "b"));
    Harness.deepEqual(list.items.map(row => row.key), ["a", "b"], "both of them");
};
