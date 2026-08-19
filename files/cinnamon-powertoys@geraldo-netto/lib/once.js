/*
 * cinnamon-powertoys - settle exactly once.
 *
 * Almost everything asynchronous here settles a caller from more than one
 * route: a reply and a timeout, a reply and a teardown, a failure raised
 * before the callback was installed and the callback itself. Every one of
 * those needs the same rule - the first arrival wins and the rest are
 * ignored - and it had been hand-rolled at eight separate places, each with
 * its own flag name and each a place the contract could quietly be broken.
 *
 * `called` is exposed because a caller sometimes has to ask before doing
 * work: ddcutil is only killed while its command can still be settled.
 */
function once(callback) {
    let wrapped = (...args) => {
        if (wrapped.called)
            return undefined;
        wrapped.called = true;
        return callback(...args);
    };
    wrapped.called = false;
    return wrapped;
}
