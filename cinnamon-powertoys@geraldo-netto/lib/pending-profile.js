/*
 * cinnamon-powertoys - the profile that has been asked for and has not arrived.
 *
 * Neither backend answers at once: the daemon replies over D-Bus, the ACPI
 * path goes through a password dialog. Until one of them does, the panel and
 * the menu draw what was asked for rather than what the last reading said, so
 * that a change can be seen the moment it is clicked.
 *
 * That is three flags and a rule about each, spread across the five places
 * that ask for a profile, draw one, or step to the next - which is how it came
 * to have two faults at once. An error arriving for an older request cleared a
 * newer one; and nothing at all cleared it when the machine simply never
 * adopted the profile, so the panel could sit for the rest of the session
 * showing a profile the machine was not in, with that profile impossible to
 * ask for again because asking again looked like a duplicate.
 *
 * So it is one object with the rule in it. Nothing here knows what a profile
 * is - they are opaque names - and nothing draws anything.
 */

/*
 * How many readings a profile that was written may go on being drawn before
 * the machine is taken at its word.
 *
 * Counted only after the write came back accepted, because until then nothing
 * has happened yet and a password dialog can be on screen for as long as it
 * likes. After it, both backends should show the new value on the very next
 * reading - the daemon signals the change, the firmware path re-reads the file
 * it has just written - so three is generous rather than tight, and it is
 * there for the case where the answer is never going to come: firmware that
 * takes a platform profile and quietly reverts on its own thermal policy.
 */
var READINGS_BEFORE_LAPSING = 3;

var PendingProfile = class PendingProfile {
    /*
     * `onLapse` is called as (asked, actual) when a profile that was written
     * has been waited out. It is the only trace there is - the panel simply
     * goes back to the truth, which from the outside looks like nothing having
     * happened, because nothing did.
     */
    constructor(onLapse) {
        this._onLapse = onLapse || function () {};
        this._name = null;
        this._written = false;
        this._readings = 0;
    }

    /* The profile to draw, or null to draw whatever the reading says. */
    get value() {
        return this._name;
    }

    /*
     * Asks for a profile. Answers whether this is a new request - false where
     * it is the one already in flight, which is not a change and must not be
     * written a second time.
     */
    ask(name) {
        if (name === this._name)
            return false;
        this._name = name;
        this._written = false;
        this._readings = 0;
        return true;
    }

    /*
     * Starts a write and makes its synchronous acceptance part of the state
     * transition.
     *
     * A backend may answer through the callback later, refuse by returning
     * false now, or throw before it has started anything. Keeping all three
     * exits here means a request is never left drawn merely because the
     * transport failed before it could produce an asynchronous answer.
     */
    request(name, write, onResult) {
        if (!this.ask(name))
            return false;

        let report = onResult || function () {};
        let answered = false;
        let done = outcome => {
            if (answered)
                return;
            answered = true;
            /* A truthy outcome is not necessarily an Error: the daemon client
             * also reports an intentionally superseded queued write. It was
             * not written either way, and the name guard keeps an obsolete
             * answer from disturbing the newer request that replaced it. */
            if (outcome)
                this.failed(name);
            else
                this.written(name);
            report(outcome || null);
        };

        let accepted;
        try {
            accepted = write(done);
        } catch (error) {
            done(error);
            return false;
        }

        if (accepted === false) {
            if (!answered)
                done(new Error("profile request was refused"));
            else
                this.failed(name);
            return false;
        }
        return true;
    }

    /*
     * The backend took the write. The machine is expected to adopt it now, so
     * this is where the waiting starts.
     *
     * Named, because a second profile may have been asked for while this one
     * was in flight; the older call's answer must not touch the newer request.
     */
    written(name) {
        if (name === this._name)
            this._written = true;
    }

    /* The backend refused it, or the user dismissed the dialog. Same guard. */
    failed(name) {
        if (name === this._name)
            this.forget();
    }

    /*
     * One reading of the machine. Clears the request where the machine has
     * caught up with it, and where it has had long enough to and has not.
     */
    settle(active) {
        if (this._name === null)
            return;
        if (active === this._name) {
            this.forget();
            return;
        }
        if (!this._written)
            return;
        this._readings++;
        if (this._readings < READINGS_BEFORE_LAPSING)
            return;
        let asked = this._name;
        this.forget();
        this._onLapse(asked, active);
    }

    forget() {
        this._name = null;
        this._written = false;
        this._readings = 0;
    }
};
