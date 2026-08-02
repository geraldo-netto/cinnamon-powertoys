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

/*
 * The one thing this module does on the bus, so that a caller can hand it
 * something else.
 *
 * Every other backend here takes its way out as a parameter - ddc.js a `run`,
 * bluez.js a `call`, privileged.js a `spawn`, cpu.js and power-supply.js a
 * runner and the IO root - which is why each of them has cases that run
 * anywhere. This one built its proxy itself, so nothing but a live settings
 * daemon could exercise it and nothing ever did.
 *
 * A failure to build the proxy at all is reported the same way a failure to
 * connect is, since to everything above they mean the same thing: there is no
 * backlight to be had here.
 */
function connectProxy(xml, onDone) {
    try {
        let wrapper = Gio.DBusProxy.makeProxyWrapper(xml);
        new wrapper(Gio.DBus.session, BUS_NAME, OBJECT_PATH, onDone);
    } catch (error) {
        onDone(null, error);
    }
}

var BacklightControl = class BacklightControl {
    /*
     * onChanged fires when anything else moves this backlight - a function
     * key, the stock applet, the daemon dimming on idle. onReady fires once,
     * when it is known whether there is a backlight here at all. `connect` is
     * how the proxy is reached; see connectProxy above.
     */
    constructor(kind, onChanged, onReady, connect) {
        this.kind = kind;
        this.available = false;
        this.percentage = null;
        this.destroyed = false;

        this._onChanged = onChanged || function () {};
        this._onReady = onReady || function () {};
        this._connect = connect || connectProxy;
        this._proxy = null;
        this._signalId = 0;

        let xml = INTERFACES[kind];
        if (!xml) {
            this._onReady();
            return;
        }

        this._connect(xml, (proxy, error) => {
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

    /*
     * The keyboard backlight's own toggle: off, or back to where it was. Only
     * that interface has it, and on the others this does nothing.
     */
    toggle(onDone) {
        if (!this._proxy || typeof this._proxy.ToggleRemote !== "function")
            return;
        this._proxy.ToggleRemote((result, error) => {
            if (this.destroyed)
                return;
            if (!error && result)
                this.percentage = result[0];
            if (onDone)
                onDone();
        });
    }

    /*
     * Several notches, the size of which is the daemon's business.
     *
     * The wheel over the applet gathers a flick before it reaches here, so
     * what arrives is a count rather than one click. They are applied one
     * after another rather than turned into a percentage, because the notch is
     * the daemon's to size and it is the same notch the brightness keys use -
     * the whole reason this goes through the daemon at all. The round trips
     * cost nothing worth avoiding: it is answering from memory.
     */
    stepBy(notches, onDone) {
        let done = onDone || function () {};
        let remaining = Math.abs(Math.round(notches));
        if (!this._proxy || remaining === 0) {
            done();
            return;
        }

        let up = notches > 0;
        let next = () => {
            if (this.destroyed || remaining === 0) {
                done();
                return;
            }
            remaining--;
            let call = up ? this._proxy.StepUpRemote : this._proxy.StepDownRemote;
            call.call(this._proxy, (result, error) => {
                if (this.destroyed) {
                    done();
                    return;
                }
                if (!error && result)
                    this.percentage = result[0];
                next();
            });
        };
        next();
    }

    /* One notch, which is what the slider's own wheel sends. */
    step(up, onDone) {
        this.stepBy(up ? 1 : -1, onDone);
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
