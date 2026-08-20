/*
 * A privileged call, whether its outcome is worth interrupting somebody for,
 * and in whose words.
 *
 * These five were methods on the applet, which holds the tray the notification
 * goes in and the setting that says whether privileged changes are allowed at
 * all. Neither is a reason to keep them there: a tray is a port and a setting
 * is a question somebody can be asked. What is left once both are passed in is
 * a policy - the gate answered in one sentence, the menu dropped before a
 * password dialog, the outcome turned into news or into silence - and it is
 * the part of this applet that a user only ever meets when something has gone
 * wrong, which is exactly the part no case could reach while it lived on a
 * class that needs Cinnamon to exist.
 *
 * What a code means in words is lib/helper-messages.js. This is when it is
 * said.
 */

const HelperMessages = require("./lib/helper-messages.js");
const Reading = require("./lib/reading.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

const HelperCalls = class HelperCalls {
    /*
     * Ports, all optional so a case can supply only the ones it is about:
     *
     *   helper       the privileged helper - anything with run(args, onDone)
     *   notifications  the tray - notify(title, body) and error(title, body)
     *   allowed()    whether privileged changes are permitted at all
     *   gone()       whether the applet has left the panel; a late answer to a
     *                call started before that is dropped rather than drawn
     *   settled()    a privileged call has answered, so the reading is stale
     *   accepted()   a write is under way, so the menu should say so now
     *   closeMenu()  drop the modal grab before pkexec puts a dialog up
     */
    constructor(ports) {
        ports = ports || {};
        this._helper = ports.helper || null;
        this._notifications = ports.notifications || null;
        this._allowed = ports.allowed || function () { return false; };
        this._gone = ports.gone || function () { return false; };
        this._settled = ports.settled || function () {};
        this._accepted = ports.accepted || function () {};
        this._closeMenu = ports.closeMenu || function () {};
    }

    /*
     * The spine both privileged callers share.
     *
     * The privileged-controls gate answered in one sentence, the menu closed
     * for the password dialog, the helper run, and - if the applet is still
     * alive when it answers - the stale-helper warning and a redraw. What an
     * outcome is worth telling the user is the caller's, and only the
     * caller's: `handlers.report` turns an outcome into the one `onDone`
     * receives, and `handlers.accepted` runs once the gate has passed and
     * before the dialog. Both are optional.
     *
     * `onDone` is optional and is answered exactly once either way, including
     * when the gate refuses. lib/backlight.js and lib/ddc.js pay for the same
     * guarantee on the other side of the applet: a caller that waits on a call
     * which never answers waits for ever, and "nobody waits on this one today"
     * is a fact about today's callers rather than about this method.
     */
    call(args, handlers, onDone) {
        handlers = handlers || {};
        let settle = outcome => {
            if (onDone)
                onDone(outcome);
        };

        /* The gate is an outcome like any other, and it goes through the
         * caller's `report` like any other. It used to go straight to `onDone`
         * instead, which meant the one refusal in this applet that knows
         * exactly why the change did not happen was also the only one nobody
         * was ever told about: `run` says what an unapplied outcome was, and
         * `run` was not being asked. */
        if (!this._allowed()) {
            let refused = HelperMessages.disabledOutcome();
            settle(handlers.report ? handlers.report(refused) : refused);
            return;
        }

        if (handlers.accepted)
            handlers.accepted();
        this._closeMenu();

        this._helper.run(args, outcome => {
            if (this._gone())
                return;
            this.reportWarning(outcome);
            this._settled();
            settle(handlers.report ? handlers.report(outcome) : outcome);
        });
    }

    /*
     * Governor, energy preference, boost and charge limit are root owned, so
     * they go through a small validating helper launched with pkexec.
     *
     * The gate is here rather than inside the helper: whether the user has
     * allowed these changes at all is a setting, and a setting is the applet's
     * business. What the helper answers is turned into a notification here,
     * because deciding what is worth interrupting somebody for is not
     * something the module that spawns a process should do.
     */
    run(args, onDone) {
        this.call(args, {
            /* So the menu shows the change as in flight straight away rather
             * than when the helper answers. */
            accepted: () => this._accepted(),
            report: outcome => {
                if (outcome.applied) {
                    /*
                     * A privileged change ends with a password dialog and
                     * then, until now, nothing - so the last thing that
                     * happened was being asked for a password, and whether it
                     * worked had to be inferred from the menu reading
                     * differently next time it was opened. Say what changed.
                     *
                     * Power profiles are not confirmed this way and do not
                     * need to be: the panel icon is green, yellow or red, and
                     * it changes colour as they take effect.
                     */
                    let changed = Reading.describeChange(args);
                    if (changed)
                        this._notify(changed);
                } else if (!outcome.cancelled) {
                    /* Cancelled means the user closed the dialog or the
                     * password did not check out; they do not need telling
                     * what they just did. */
                    this._error(HelperMessages.errorMessage(outcome));
                }
                return outcome;
            },
        }, onDone);
    }

    /*
     * The helper without the notification policy, for a caller that reports
     * the outcome in its own words - a profile that will not switch is not
     * the same news as a governor that will not.
     */
    quietly(args, onDone) {
        this.call(args, {
            report: outcome => HelperMessages.describedOutcome(outcome),
        }, onDone);
    }

    /* An outdated helper is worth saying beside a change that worked, because
     * a warning that only fired on failure would never be seen on the machine
     * it is about. What to say is lib/helper-messages.js; when, here. */
    reportWarning(outcome) {
        let message = HelperMessages.warningMessage(outcome);
        if (message)
            this._error(message);
    }

    /* A profile that would not switch, which is not a helper outcome at all -
     * on the daemon path there is no helper in it - but is the same news from
     * the same control, said in the same tray. */
    profileError(name, error) {
        this._error(HelperMessages.profileErrorMessage(name, error));
    }

    _notify(message) {
        if (this._notifications)
            this._notifications.notify(_("Power Toys"), message);
    }

    _error(message) {
        if (this._notifications)
            this._notifications.error(_("Power Toys"), message);
    }
};
