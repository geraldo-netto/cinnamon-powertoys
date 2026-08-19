/*
 * Which of the two profile writers this applet is talking to, and since when.
 *
 * There are two: power-profiles-daemon where it is running, and the firmware's
 * own platform_profile where it is not. Which one answers is not a fact a
 * caller should have to work out - and the applet worked it out in one method
 * while three others carried the consequences: a generation counter to tell one
 * adoption of the same daemon from the next, a comparison every late reply had
 * to make before it was allowed to land, and the snapshot shape the reading is
 * assembled from.
 *
 * All four are here, where a case can move the daemon out from under a reply in
 * flight without a bus.
 */

const ProfileView = require("./lib/profile-view.js");

const ProfileSelection = class ProfileSelection {
    /*
     * `daemon` is the power-profiles-daemon client and `platform` the firmware
     * fallback; both are asked for `available` and nothing else here.
     * `onOwnerChanged()` is called after the writer has moved, for whatever the
     * caller has to let go of - an optimistic profile that the new writer never
     * accepted, above all.
     */
    constructor(daemon, platform, onOwnerChanged) {
        this._daemon = daemon;
        this._platform = platform;
        this._ownerChanged = onOwnerChanged || function () {};
        this._backend = null;
        this._available = false;
        /* Bumped on every move, because the backend object alone cannot tell
         * one adoption of the same daemon from the next: the same client is
         * re-used when its bus name changes owner. */
        this._generation = 0;
    }

    get backend() {
        return this._backend;
    }

    get generation() {
        return this._generation;
    }

    /* Whether the writer in use is the firmware one, which unlike the daemon
     * needs the privileged helper for every write. */
    get isPlatform() {
        return this._backend !== null && this._backend === this._platform;
    }

    /*
     * Ask again which backend answers. Reports whether it moved.
     *
     * When there is neither, the daemon client is still the one asked: it
     * answers unavailable, null and an empty list, which is exactly how a
     * machine with no profiles should read.
     *
     * Availability is part of the answer and not only the identity, because the
     * same client going from unavailable to available is the daemon arriving,
     * and a request accepted before it arrived was accepted by nobody.
     */
    choose() {
        let backend = this._daemon.available ? this._daemon
            : (this._platform.available ? this._platform : this._daemon);
        let available = !!backend.available;
        if (backend === this._backend && available === this._available)
            return false;

        this._backend = backend;
        this._available = available;
        this._generation++;
        this._ownerChanged();
        return true;
    }

    /*
     * Whether the writer a piece of work started against is still the one in
     * use.
     *
     * A snapshot or a reply from before a move describes neither the current
     * controls nor the current writer, so it must not be presented. Both the
     * collection and the write path ask this the same way.
     */
    stillOwned(backend, generation) {
        return ProfileView.sameOwner({ source: backend, generation: generation },
                                     this._backend, this._generation);
    }

    /*
     * One look at whichever backend answered, rather than six. Each of them has
     * its own reason for that mattering: the firmware one opens two files per
     * property, the daemon one unpacks a variant per property.
     *
     * The owner is carried in the result, so what is assembled from it can
     * still be told apart from what a later writer would have produced.
     */
    snapshot(backend, generation) {
        let state = backend.snapshot();
        return {
            available: state.available,
            backend: state.busName,
            active: state.active,
            list: state.profiles,
            degraded: state.degraded,
            holds: state.holds,
            source: backend,
            generation: generation,
        };
    }

    /* Teardown: the clients belong to the applet, so only the choice is let
     * go of here. Nothing may be found to be still owned afterwards. */
    release() {
        this._backend = null;
        this._available = false;
    }
};
