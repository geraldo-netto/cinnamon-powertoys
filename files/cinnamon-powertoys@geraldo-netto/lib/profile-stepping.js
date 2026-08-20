/*
 * One step along the list of power profiles, from the profile that has been
 * asked for rather than from the one the machine has got round to.
 *
 * The wheel, the middle click and the hotkey all do this, and all three used
 * to do it on the applet - the one class in this tree no case can construct.
 * That is the whole reason it is here: what a notch means is arithmetic
 * (lib/profiles.js), which profile block may be stepped at all is a policy
 * (lib/profile-view.js), and the stepping between them was the part that could
 * only be checked by opening a session.
 *
 * What the applet keeps is the write itself. Asking for a profile means a
 * pending request, a writer that may be replaced mid-flight and a redraw, and
 * all three are the applet's; `setProfile` is that write, handed in.
 */

const Profiles = require("./lib/profiles.js");
const ProfileView = require("./lib/profile-view.js");
const Reading = require("./lib/reading.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const ProfileStepper = class ProfileStepper {
    /*
     * Ports, all optional:
     *
     *   reading()      the latest reading, or null before the first one
     *   pending()      the profile asked for and not yet arrived, or null
     *   selection      lib/profile-selection.js - who answers, and which
     *                  adoption of them this is
     *   platformProfiles  the firmware writer, compared against by identity so
     *                  a change going through a password dialog can be told
     *                  from a D-Bus round trip
     *   helper         the privileged helper, asked only whether it is busy
     *   privileged()   whether privileged changes are allowed at all
     *   setProfile(name, onResult)  ask for a profile; true if it was taken
     *   notifications  the tray - notify(title, body)
     */
    constructor(ports) {
        ports = ports || {};
        this._reading = ports.reading || function () { return null; };
        this._pending = ports.pending || function () { return null; };
        this._selection = ports.selection || null;
        this._platformProfiles = ports.platformProfiles || null;
        this._helper = ports.helper || null;
        this._privileged = ports.privileged || function () { return false; };
        this._setProfile = ports.setProfile || function () { return false; };
        this._notifications = ports.notifications || null;
    }

    /*
     * A profile block the applet is currently allowed to change. The daemon
     * is unprivileged; the ACPI fallback follows the privileged-control
     * setting, so wheel, middle click and hotkey stop at the same gate as the
     * menu segment.
     */
    state() {
        return ProfileView.steppableState(this._reading(), this.context());
    }

    /* What the applet knows about the profile control that the reading does
     * not: who it is talking to, whether that writer is the ACPI platform
     * profile, whether a password dialog is already up for it, and whether
     * privileged changes are allowed at all. */
    context() {
        return {
            backend: this._selection ? this._selection.backend : null,
            generation: this._selection ? this._selection.generation : 0,
            platformProfiles: this._platformProfiles,
            busy: !!this._helper?.busy,
            privileged: this._privileged(),
        };
    }

    /*
     * The profile that has been asked for, rather than the one the machine has
     * got round to.
     *
     * Those are the same value except while a change is in flight, and that
     * window is not always short: on the firmware path it is as long as a
     * password dialog is on screen. Every caller here wants the same one, and
     * it is the same question the panel gauge, the panel label and the filled
     * segment ask.
     */
    shown() {
        return Reading.shownProfile(this._reading(),
                                    { pendingProfile: this._pending() });
    }

    /*
     * One step along that list.
     *
     * Stepped from the profile being shown rather than the one the machine has
     * got round to, because those differ for as long as a change is in flight
     * - a D-Bus round trip under power-profiles-daemon, and on the ACPI
     * platform profile for as long as a password dialog is on screen.
     * Stepping from the old value there computed the same target again, the
     * write was dropped as a duplicate, and the wheel and the hotkey did
     * nothing at all for the whole of it - while the hotkey went on announcing
     * a change that was not happening, because it announced whether or not the
     * call had been taken.
     */
    step(step, wrap, announce) {
        let state = this.state();
        if (!state)
            return false;

        /* Null where the step lands where it already was; that rule, and the
         * clamping at the ends, are lib/profiles.js. */
        let name = Profiles.nextProfile(state.list, this.shown(), step, wrap);
        if (!name)
            return false;

        /* Acceptance means a write is in progress, not that it happened.
         * Announce only when this exact request answers successfully; the
         * pending panel state is the feedback while it is in flight. */
        return this._setProfile(name, error => {
            if (announce && !error)
                this._announce(name);
        });
    }

    /* The middle click and the hotkey: round the list, wrapping, and said out
     * loud because neither of them necessarily has the menu open to watch. */
    cycle() {
        return this.step(1, true, true);
    }

    _announce(name) {
        if (this._notifications)
            this._notifications.notify(_("Power Toys"), ProfileView.announcement(name));
    }
};
