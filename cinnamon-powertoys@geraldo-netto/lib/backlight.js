/*
 * cinnamon-powertoys - screen and keyboard backlight.
 *
 * cinnamon-settings-daemon owns both, on one object carrying one interface
 * each. The interfaces are exported whether or not the machine has the
 * backlight behind them - a desktop with no panel backlight still answers
 * org.cinnamon.SettingsDaemon.Power.Screen, with an error - so whether there
 * is one to control is only known once the daemon has been asked. That is why
 * available starts false and why the caller is told when the answer is in.
 */

const Gio = imports.gi.Gio;

var BUS_NAME = "org.cinnamon.SettingsDaemon.Power";
var OBJECT_PATH = "/org/cinnamon/SettingsDaemon/Power";

/*
 * The two are the same control with the same calls; they differ only in what
 * StepUp and StepDown answer, and in the keyboard's toggle. Only the parts
 * used here are declared.
 */
const SCREEN_XML = '<node>\
<interface name="org.cinnamon.SettingsDaemon.Power.Screen">\
    <method name="StepUp">\
        <arg type="u" direction="out"/><arg type="i" direction="out"/><arg type="i" direction="out"/>\
    </method>\
    <method name="StepDown">\
        <arg type="u" direction="out"/><arg type="i" direction="out"/><arg type="i" direction="out"/>\
    </method>\
    <method name="GetPercentage"><arg type="u" direction="out"/></method>\
    <method name="SetPercentage"><arg type="u" direction="in"/><arg type="u" direction="out"/></method>\
    <signal name="Changed"/>\
</interface>\
</node>';

const KEYBOARD_XML = '<node>\
<interface name="org.cinnamon.SettingsDaemon.Power.Keyboard">\
    <method name="StepUp"><arg type="u" direction="out"/></method>\
    <method name="StepDown"><arg type="u" direction="out"/></method>\
    <method name="Toggle"><arg type="u" direction="out"/></method>\
    <method name="GetPercentage"><arg type="u" direction="out"/></method>\
    <method name="SetPercentage"><arg type="u" direction="in"/><arg type="u" direction="out"/></method>\
    <signal name="Changed"/>\
</interface>\
</node>';

var SCREEN = "screen";
var KEYBOARD = "keyboard";

const INTERFACES = {};
INTERFACES[SCREEN] = SCREEN_XML;
INTERFACES[KEYBOARD] = KEYBOARD_XML;

var BacklightControl = class BacklightControl {
    /*
     * onChanged fires when anything else moves this backlight - a function
     * key, the stock applet, the daemon dimming on idle. onReady fires once,
     * when it is known whether there is a backlight here at all.
     */
    constructor(kind, onChanged, onReady) {
        this.kind = kind;
        this.available = false;
        this.percentage = null;
        this.destroyed = false;

        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._proxy = null;
        this._signalId = 0;

        let xml = INTERFACES[kind];
        if (!xml) {
            this._onReady();
            return;
        }

        try {
            let wrapper = Gio.DBusProxy.makeProxyWrapper(xml);
            new wrapper(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                if (this.destroyed)
                    return;
                if (error || !proxy) {
                    this._onReady();
                    return;
                }
                this._proxy = proxy;
                this._signalId = proxy.connectSignal("Changed",
                                                     () => this.refresh(() => this._onChanged()));
                this.refresh(() => this._onReady());
            });
        } catch (e) {
            this._onReady();
        }
    }

    /* Asks the daemon where the backlight is now. An error here is the
     * answer to "is there one", not a failure worth reporting. */
    refresh(onDone) {
        let done = onDone || function () {};
        if (!this._proxy) {
            done();
            return;
        }
        this._proxy.GetPercentageRemote((result, error) => {
            if (this.destroyed)
                return;
            if (error || !result) {
                this.available = false;
                this.percentage = null;
            } else {
                this.available = true;
                this.percentage = result[0];
            }
            done();
        });
    }

    setPercentage(value, onDone) {
        if (!this._proxy)
            return;
        let wanted = Math.max(0, Math.min(100, Math.round(value)));
        this._proxy.SetPercentageRemote(wanted, (result, error) => {
            if (this.destroyed)
                return;
            /* The daemon answers with what it actually set, which is not
             * always what was asked for: some panels have far fewer steps. */
            if (!error && result)
                this.percentage = result[0];
            if (onDone)
                onDone();
        });
    }

    /* One notch, the size of which is the daemon's business. */
    step(up, onDone) {
        if (!this._proxy)
            return;
        let call = up ? this._proxy.StepUpRemote : this._proxy.StepDownRemote;
        call.call(this._proxy, (result, error) => {
            if (this.destroyed)
                return;
            if (!error && result)
                this.percentage = result[0];
            if (onDone)
                onDone();
        });
    }

    destroy() {
        this.destroyed = true;
        if (this._proxy && this._signalId) {
            try {
                this._proxy.disconnectSignal(this._signalId);
            } catch (e) {
                /* already gone */
            }
        }
        this._proxy = null;
        this._signalId = 0;
        this.available = false;
    }
};
