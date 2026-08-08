/*
 * The narrow boundary between the applet and Cinnamon's panel implementation.
 *
 * Labels, tooltips and named icons have public applet methods. Cinnamon does
 * not expose the tooltip lifecycle or a way to put a Gio.Icon on an applet,
 * though, so those two capabilities are detected here and nowhere else. A
 * shell version that changes either private object keeps the public fallback,
 * and everything installed here is put back when the applet is removed.
 */

function _leftAlignedStyle(style) {
    let original = typeof style === "string" ? style : "";
    if (original.trim() === "")
        return "text-align: left;";
    return original + (/;\s*$/.test(original) ? " " : "; ") + "text-align: left;";
}

const PanelAdapter = class PanelAdapter {
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
        let tooltip = this._applet?._applet_tooltip;
        if (!tooltip)
            return false;

        if (typeof tooltip.show !== "function" || typeof tooltip.hide !== "function")
            return false;

        let originalShow = tooltip.show;
        let originalHide = tooltip.hide;
        this._wrappedShow = function () {
            this._beforeTooltip();
            let result = originalShow.apply(tooltip, arguments);
            this._publishTooltip(this._visibleAfter(true));
            return result;
        }.bind(this);
        this._wrappedHide = function () {
            let result = originalHide.apply(tooltip, arguments);
            this._publishTooltip(this._visibleAfter(false));
            return result;
        }.bind(this);
        if (!this._replaceTooltipHooks(tooltip, originalShow, originalHide))
            return false;

        this._tooltip = tooltip;
        this._originalShow = originalShow;
        this._originalHide = originalHide;
        this._stylePrivateTooltip(tooltip);
        return true;
    }

    _replaceTooltipHooks(tooltip, originalShow, originalHide) {
        /* Some shell revisions expose these members without allowing them to
         * be replaced. Publish no partial integration if either assignment is
         * unusable. In particular, the actor has not been touched yet. */
        try {
            tooltip.show = this._wrappedShow;
            tooltip.hide = this._wrappedHide;
            if (tooltip.show !== this._wrappedShow || tooltip.hide !== this._wrappedHide)
                throw new Error("tooltip lifecycle hooks are not writable");
        } catch (error) {
            try { tooltip.show = originalShow; } catch (error_) {}
            try { tooltip.hide = originalHide; } catch (error_) {}
            return false;
        }
        return true;
    }

    _stylePrivateTooltip(tooltip) {
        /* Alignment is optional decoration on a now-working integration.
         * Preserve every declaration Cinnamon or the theme already supplied,
         * append our override, and retain the exact original for teardown. */
        let actor = tooltip._tooltip;
        if (actor && typeof actor.get_style === "function" &&
                typeof actor.set_style === "function") {
            let originalStyle;
            let styleRead = false;
            try {
                originalStyle = actor.get_style();
                styleRead = true;
                actor.set_style(_leftAlignedStyle(originalStyle));
                this._originalTooltipStyle = originalStyle;
                this._tooltipActor = actor;
                this._changedTooltipStyle = true;
            } catch (error) {
                /* Lifecycle hooks remain useful when styling is unavailable. */
                if (styleRead) {
                    try { actor.set_style(originalStyle); } catch (error_) {}
                }
            }
        }
    }

    /* Public actor events keep tooltip text current if private hooks disappear. */
    _installHoverFallback() {
        let actor = this._applet?.actor;
        if (!actor || typeof actor.connect !== "function" ||
            typeof actor.disconnect !== "function")
            return false;

        let signals = [];
        try {
            let enter = actor.connect("enter-event", () => {
                this._beforeTooltip();
                this._publishTooltip(true);
            });
            if (!enter)
                throw new Error("enter-event did not return a signal id");
            signals.push(enter);
            let leave = actor.connect("leave-event", () => {
                this._publishTooltip(false);
            });
            if (!leave)
                throw new Error("leave-event did not return a signal id");
            signals.push(leave);
        } catch (error) {
            for (let id of signals) {
                try { actor.disconnect(id); } catch (error_) {}
            }
            return false;
        }
        this._hoverActor = actor;
        this._hoverSignals = signals;
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
        let actor = this._applet?._applet_icon;
        if (!actor || !icon)
            return false;
        try {
            actor.gicon = icon;
            return true;
        } catch (e) {
            return false;
        }
    }

    _restoreTooltipHooks() {
        if (!this._tooltip)
            return;
        try {
            if (this._tooltip.show === this._wrappedShow)
                this._tooltip.show = this._originalShow;
        } catch (e) {
            /* Cinnamon may freeze a private member before teardown. */
        }
        try {
            if (this._tooltip.hide === this._wrappedHide)
                this._tooltip.hide = this._originalHide;
        } catch (e) {
            /* Restore every independent hook best-effort. */
        }
    }

    _restoreTooltipStyle() {
        if (!this._changedTooltipStyle || !this._tooltipActor ||
            typeof this._tooltipActor.set_style !== "function")
            return;
        try {
            this._tooltipActor.set_style(this._originalTooltipStyle);
        } catch (e) {
            /* The actor may already be final. */
        }
    }

    _disconnectHover() {
        if (!this._hoverActor)
            return;
        for (let id of this._hoverSignals) {
            try {
                this._hoverActor.disconnect(id);
            } catch (e) {
                /* The actor may already have been destroyed by Cinnamon. */
            }
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._restoreTooltipHooks();
        this._restoreTooltipStyle();
        this._disconnectHover();
        this._hoverSignals = [];
        this._publishTooltip(false);
        this._beforeTooltip = function () {};
        this._onTooltip = function () {};
        this._applet = null;
    }
};
