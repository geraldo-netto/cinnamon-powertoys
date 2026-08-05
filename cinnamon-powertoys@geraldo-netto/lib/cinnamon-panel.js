/*
 * The narrow boundary between the applet and Cinnamon's panel implementation.
 *
 * Labels, tooltips and named icons have public applet methods. Cinnamon does
 * not expose the tooltip lifecycle or a way to put a Gio.Icon on an applet,
 * though, so those two capabilities are detected here and nowhere else. A
 * shell version that changes either private object keeps the public fallback,
 * and everything installed here is put back when the applet is removed.
 */

var PanelAdapter = class PanelAdapter {
    constructor(applet, callbacks) {
        callbacks = callbacks || {};
        this._applet = applet;
        this._beforeTooltip = callbacks.beforeTooltip || function () {};
        this._onTooltip = callbacks.onTooltip || function () {};
        this._tooltipVisible = false;
        this._destroyed = false;

        this._tooltip = null;
        this._originalShow = null;
        this._originalHide = null;
        this._wrappedShow = null;
        this._wrappedHide = null;
        this._tooltipActor = null;
        this._originalTooltipStyle = null;
        this._changedTooltipStyle = false;

        this._hoverActor = null;
        this._hoverSignals = [];
        this._hasTooltipLifecycle = this._installPrivateTooltip();
        if (!this._hasTooltipLifecycle)
            this._hasTooltipLifecycle = this._installHoverFallback();
    }

    _installPrivateTooltip() {
        let tooltip = this._applet && this._applet._applet_tooltip;
        if (!tooltip)
            return false;

        let actor = tooltip._tooltip;
        if (actor && typeof actor.set_style === "function") {
            if (typeof actor.get_style === "function")
                this._originalTooltipStyle = actor.get_style();
            actor.set_style("text-align: left;");
            this._tooltipActor = actor;
            this._changedTooltipStyle = true;
        }

        if (typeof tooltip.show !== "function" || typeof tooltip.hide !== "function")
            return false;

        this._tooltip = tooltip;
        this._originalShow = tooltip.show;
        this._originalHide = tooltip.hide;
        let self = this;
        this._wrappedShow = function () {
            self._beforeTooltip();
            let result = self._originalShow.apply(tooltip, arguments);
            self._publishTooltip(self._visibleAfter(true));
            return result;
        };
        this._wrappedHide = function () {
            let result = self._originalHide.apply(tooltip, arguments);
            self._publishTooltip(self._visibleAfter(false));
            return result;
        };
        tooltip.show = this._wrappedShow;
        tooltip.hide = this._wrappedHide;
        return true;
    }

    /* Public actor events keep tooltip text current if private hooks disappear. */
    _installHoverFallback() {
        let actor = this._applet && this._applet.actor;
        if (!actor || typeof actor.connect !== "function" ||
            typeof actor.disconnect !== "function")
            return false;

        this._hoverActor = actor;
        this._hoverSignals.push(actor.connect("enter-event", () => {
            this._beforeTooltip();
            this._publishTooltip(true);
        }));
        this._hoverSignals.push(actor.connect("leave-event", () => {
            this._publishTooltip(false);
        }));
        return true;
    }

    _visibleAfter(fallback) {
        return this._tooltip && typeof this._tooltip.visible === "boolean"
            ? this._tooltip.visible : fallback;
    }

    _publishTooltip(visible) {
        visible = !!visible;
        if (visible === this._tooltipVisible)
            return;
        this._tooltipVisible = visible;
        this._onTooltip(visible);
    }

    get tooltipVisible() {
        return this._tooltipVisible;
    }

    get hasTooltipLifecycle() {
        return this._hasTooltipLifecycle;
    }

    setLabel(text) {
        if (this._applet && typeof this._applet.set_applet_label === "function")
            this._applet.set_applet_label(text);
    }

    setTooltip(text) {
        if (this._applet && typeof this._applet.set_applet_tooltip === "function")
            this._applet.set_applet_tooltip(text);
    }

    setSymbolicIcon(name) {
        if (this._applet && typeof this._applet.set_applet_icon_symbolic_name === "function")
            this._applet.set_applet_icon_symbolic_name(name);
    }

    setIconPath(path) {
        if (this._applet && typeof this._applet.set_applet_icon_path === "function")
            this._applet.set_applet_icon_path(path);
    }

    /* A named icon is the public fallback when the private icon actor moved.
     * UPower already supplied the exact battery state as an icon name; the
     * public symbolic setter wants that name without the suffix it adds. */
    setBatteryIcon(fallbackName, icon, sourceName) {
        let named = typeof sourceName === "string" &&
                    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceName)
            ? sourceName.replace(/-symbolic$/, "") : "";
        this.setSymbolicIcon(named || fallbackName);
        let actor = this._applet && this._applet._applet_icon;
        if (!actor || !icon)
            return false;
        try {
            actor.gicon = icon;
            return true;
        } catch (e) {
            return false;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._tooltip) {
            if (this._tooltip.show === this._wrappedShow)
                this._tooltip.show = this._originalShow;
            if (this._tooltip.hide === this._wrappedHide)
                this._tooltip.hide = this._originalHide;
        }
        if (this._changedTooltipStyle && this._tooltipActor &&
            typeof this._tooltipActor.set_style === "function")
            this._tooltipActor.set_style(this._originalTooltipStyle);

        if (this._hoverActor) {
            for (let id of this._hoverSignals) {
                try {
                    this._hoverActor.disconnect(id);
                } catch (e) {
                    /* The actor may already have been destroyed by Cinnamon. */
                }
            }
        }
        this._hoverSignals = [];
        this._publishTooltip(false);
        this._beforeTooltip = function () {};
        this._onTooltip = function () {};
        this._applet = null;
    }
};
