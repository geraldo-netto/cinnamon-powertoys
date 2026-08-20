/*
 * cinnamon-powertoys - the panel item.
 *
 * The text beside the icon, the icon, and the tooltip. It is given the applet
 * only to reach the four calls that put something on the panel - label,
 * symbolic icon, icon actor and tooltip - and reads nothing back out of it.
 * What to show arrives with each update, and what any of it should say is
 * lib/panel-text.js; what is left here is the putting.
 *
 * It lives under lib/ rather than under ui/ because it builds no widgets of
 * its own: Cinnamon's panel objects are behind lib/cinnamon-panel.js, so this
 * loads, and is tested, without a shell.
 */

const Gio = imports.gi.Gio;

const CinnamonPanel = require("./lib/cinnamon-panel.js");
const Format = require("./lib/format.js");
const Log = require("./lib/log.js");
const PanelText = require("./lib/panel-text.js");
const Reading = require("./lib/reading.js");

/* The applet's own icon, used whenever neither the battery nor the profile is
 * what the panel is showing. */
const DEFAULT_ICON = "powertoys";

/*
 * The panel item: the text beside the icon, the icon, and the tooltip.
 *
 * It is given the applet only to reach the four calls that put something on
 * the panel - label, symbolic icon, icon actor and tooltip - and reads
 * nothing back out of it. What to show arrives with each update, and what any
 * of it should say is lib/panel-text.js; what is left here is the putting.
 */
class PanelPresenter {
    constructor(applet, iconDir, onTooltip) {
        this._iconDir = iconDir;
        this._iconKey = null;
        this._reading = null;
        this._readingOptions = null;
        this._shell = new CinnamonPanel.PanelAdapter(applet, {
            beforeTooltip: () => this._writeTooltip(),
            onTooltip: onTooltip,
        });
    }

    /*
     * The icon cache, dropped.
     *
     * _updateIcon does nothing while the key it would set is the key already
     * set, which is what keeps a poll from costing a texture lookup - so
     * anything that changes what a key means has to say so here. A panel
     * resize and an orientation change rebuild the icon actor underneath it,
     * and an icon theme change moves every answer Format gives about which
     * names exist.
     *
     * It went out with the panel text in PT-161b while its three callers
     * stayed, so each of them threw before the redraw on the line beneath it -
     * and a theme change left the panel holding an icon from a theme that is
     * no longer installed, which is what PT-69 was closed for.
     */
    invalidateIcon() {
        this._iconKey = null;
    }

    update(data, options) {
        let profile = Reading.shownProfile(data, options);
        let source = PanelText.iconSource(data, options.iconSource, profile);
        this._shell.setLabel(PanelText.labelText(data, options, source, profile));
        this._updateIcon(data, source, profile);

        this._reading = data;
        this._readingOptions = options;
        if (this._shell.tooltipVisible || !this._shell.hasTooltipLifecycle)
            this._writeTooltip();
    }

    _writeTooltip() {
        if (this._reading)
            this._shell.setTooltip(PanelText.tooltipText(this._reading, this._readingOptions));
    }

    /* On supported Cinnamon versions this is exact. The compatibility path
     * cannot observe tooltip lifecycle, so it conservatively keeps data fresh
     * for a tooltip the shell may already be showing. */
    get tooltipNeedsFreshData() {
        return this._shell.tooltipVisible || !this._shell.hasTooltipLifecycle;
    }

    _updateIcon(data, source, profile) {
        if (source === "battery" && data.primary) {
            let icon = data.primary.icon;
            let key = "battery:" + icon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            let parsed = null;
            if (icon) {
                try {
                    parsed = Gio.icon_new_for_string(icon);
                } catch (e) {
                    /* Optional daemon metadata cannot abort presentation. */
                }
            }
            this._shell.setBatteryIcon(Format.batteryIconName(),
                                       parsed,
                                       icon);
            return;
        }

        let profileIcon = source === "profile" && profile
            ? Format.profileIconName(profile) : null;
        if (profileIcon) {
            let key = "profile:" + profileIcon;
            if (key === this._iconKey)
                return;
            this._iconKey = key;
            /*
             * Loaded from the applet's own directory by path rather than by
             * name. These three carry colour, so asking for them as symbolic
             * names would have the theme repaint all three in the panel
             * foreground and make them identical; asking by name at all
             * depends on the icon theme having noticed the applet's directory,
             * which it does not always do until something makes it rescan.
             */
            this._shell.setIconPath(this._iconDir + "/" + profileIcon + ".svg");
            return;
        }

        let key = "symbolic:" + DEFAULT_ICON;
        if (key === this._iconKey)
            return;
        this._iconKey = key;
        this._shell.setSymbolicIcon(DEFAULT_ICON);
    }

    destroy() {
        this._reading = null;
        this._readingOptions = null;
        Log.release("the panel actors", () => this._shell.destroy());
    }
}
