/*
 * What a wheel notch, a middle click and a shortcut mean.
 *
 * Three settings decide it - the wheel action, the middle-click action and the
 * two accelerators - and the applet decided each of them inline, mixed in with
 * the Clutter return values and the keybinding manager. So the rule that a
 * wheel over an applet with no backlight must fall through to the panel, and
 * the rule that a shortcut already taken is reported rather than dropped, could
 * only be exercised by opening a session and turning a wheel.
 *
 * Both are here instead. The decisions are pure: a setting and what the machine
 * can do go in, the name of an action or null comes out, and the caller does
 * the Clutter part. The shortcuts need a keybinding manager, which is the
 * shell's, so it is handed in.
 */

/*
 * The wheel.
 *
 * "brightness" is what the applet this one replaces does with the wheel, and it
 * is the default; "profile" steps the power profile instead. Either can be
 * chosen on a machine that cannot do it - a desktop with no backlight, a
 * machine with no profile daemon and no firmware profiles - and the answer
 * there is null, which the caller turns into "not mine, propagate" rather than
 * into a step that goes nowhere.
 */
function wheelAction(setting, can) {
    can = can || {};
    if (setting === "brightness")
        return can.brightness ? "brightness" : null;
    if (setting === "profile")
        return can.profile ? "profile" : null;
    return null;
}

/*
 * Middle click. The stock applet toggles the keyboard backlight, which is the
 * sort of thing nobody discovers but everybody who knew about it misses.
 *
 * Same shape as the wheel, and deliberately not the same function: the two
 * settings have different values and a machine can do one and not the other.
 */
function middleClickAction(setting, can) {
    can = can || {};
    if (setting === "keyboard-backlight")
        return can.keyboardBacklight ? "keyboard-backlight" : null;
    if (setting === "profile")
        return can.profile ? "profile" : null;
    return null;
}

/*
 * The shortcuts this applet holds, and letting go of them again.
 *
 * Registration is all-or-nothing per binding and the manager answers false when
 * an accelerator is already somebody else's. That answer used to be turned into
 * a notification in the same method that did the registering, so the applet
 * could not be told about a conflict without a tray to say it in; here the
 * conflict is reported to whoever asked and the saying stays outside.
 *
 * `apply` is the only way in, and it removes what is registered first: settings
 * change while the applet is running, and a shortcut that was moved must stop
 * answering at its old accelerator.
 */
const Hotkeys = class Hotkeys {
    /*
     * `manager` is Cinnamon's keybinding manager, or anything with
     * addHotKey(name, accelerator, action) -> boolean and removeHotKey(name).
     * `onConflict(accelerator, name)` is called for each binding the manager
     * refused.
     */
    constructor(manager, onConflict) {
        this._manager = manager;
        this._onConflict = onConflict || function () {};
        this._names = [];
    }

    /* The names currently held, for a caller that wants to assert on them. */
    get registered() {
        return this._names.slice();
    }

    /*
     * `bindings` is a list of { name, accelerator, action }. An entry with no
     * accelerator is the setting left empty, which is not a conflict and not an
     * error - it is somebody who does not want the shortcut.
     */
    apply(bindings) {
        this.release();
        for (let binding of bindings || []) {
            if (!binding || !binding.accelerator)
                continue;
            if (this._manager.addHotKey(binding.name, binding.accelerator,
                                        binding.action)) {
                this._names.push(binding.name);
                continue;
            }
            this._onConflict(binding.accelerator, binding.name);
        }
    }

    /* Teardown, and the first half of every apply. */
    release() {
        for (let name of this._names)
            this._manager.removeHotKey(name);
        this._names = [];
    }
};
