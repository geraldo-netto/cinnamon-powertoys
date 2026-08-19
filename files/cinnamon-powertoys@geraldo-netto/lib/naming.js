/*
 * Telling two things of the same name apart.
 *
 * Three lists here are named the same way: work out what each thing is
 * called, notice the names that came out alike, and append to those - and
 * only those - whatever told them apart in the first place. Two monitors of
 * one model are separated by the socket, two identical graphics cards by the
 * PCI slot, five drivetemp chips by the block device.
 *
 * Only the ambiguous ones are marked, because "Radeon RX 6600 (03:00.0)" over
 * a machine with one card is a heading that answers a question nobody asked.
 */

/*
 * `items` in, their resolved names out, in the same order.
 *
 * `name(item)` is what the thing is called before anything is appended.
 * `identity(item)` is what tells it apart, and is used only where a name is
 * shared; a thing with nothing to tell it apart keeps the shared name.
 * `scope(item)` narrows what "alike" means: two readings from one card, a fan
 * and a power meter, are both "amdgpu", and appending the same PCI slot to
 * each would leave them just as alike and longer - they are already told
 * apart by being in RPM and in watts.
 */
function disambiguate(items, options) {
    options = options || {};
    let nameOf = options.name || (item => item.name);
    let identityOf = options.identity || (item => item.identity);
    let scopeOf = options.scope || null;

    let names = items.map(item => nameOf(item));
    let keys = names.map((name, index) =>
        (scopeOf ? scopeOf(items[index]) : "") + " " + name);

    let counts = {};
    for (let key of keys)
        counts[key] = (counts[key] || 0) + 1;

    return names.map(function (name, index) {
        if (counts[keys[index]] < 2)
            return name;
        let identity = identityOf(items[index]);
        if (identity === 0 || identity)
            return name + " (" + identity + ")";
        return name;
    });
}
