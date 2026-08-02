/*
 * cinnamon-powertoys - menu rows that follow a list of values.
 *
 * Tearing a section down on every poll would drop whatever the pointer is over
 * and make the menu flicker, so the widgets are rebuilt only when the set of
 * keys changes; the rest of the time the rows that are already there are
 * handed the new values. Each entry is an object carrying a "key" plus
 * whatever create and update need.
 *
 * It is the one thing in this applet that decides rather than draws - whether
 * a section is rebuilt or updated in place, which is the whole of what keeps
 * the menu from flickering - and it needs nothing of a menu but removeAll and
 * addMenuItem. So it is out here, where the deciding can be checked against a
 * section that is not a menu at all.
 */

var KeyedList = class KeyedList {
    constructor(section, create, update) {
        this._section = section;
        this._create = create;
        this._update = update || function () {};
        this._key = null;
        this._items = new Map();
    }

    /*
     * The set of keys, as one string that cannot be forged.
     *
     * Joining the keys with a separator is only safe while no key contains
     * one, and these keys are device paths, sensor ids and profile names -
     * none of which promises that. Counting each key's length in front of it
     * means no two different sets can produce the same string, whatever is in
     * them, so a set that has really changed can never read as unchanged and
     * leave the rows as they were.
     */
    _signature(entries) {
        return entries.map(entry => String(entry.key).length + ":" + entry.key).join("");
    }

    sync(entries) {
        let key = this._signature(entries);
        if (key !== this._key) {
            this._key = key;
            this._section.removeAll();
            this._items = new Map();
            for (let entry of entries) {
                let item = this._create(entry);
                this._items.set(entry.key, item);
                this._section.addMenuItem(item);
            }
        }
        for (let entry of entries)
            this._update(this._items.get(entry.key), entry);
    }

    get items() {
        return Array.from(this._items.values());
    }
};
