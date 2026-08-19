/*
 * What the shell says the menu has room for.
 *
 * The work area rather than the monitor, so a menu is not sized to include the
 * panel it drops out of; the monitor the applet is on rather than the primary
 * one, because a second screen is often the smaller. Every part of this is a
 * shell interface that has changed shape before, so each is asked for
 * defensively and the arithmetic is left with a sane number when one of them
 * is not there - see lib/menu-layout.js, which treats a missing width as "one
 * column" rather than as zero.
 *
 * It lives here rather than in applet.js because a fallback nothing can reach
 * is a fallback nobody has run: the shell interfaces arrive as parameters, so
 * a layout manager without `findMonitorForActor`, a stage St will not answer
 * for, and a desktop with no interface schema are all reachable from a case.
 */

/* `shell` carries the collaborators the caller already holds:
 * { layout, actor, global, st, gio }. Any of them may be absent. */
function menuConstraints(shell) {
    shell = shell || {};
    return {
        availableWidth: workAreaWidth(shell),
        scaleFactor: scaleFactor(shell),
        textScale: textScale(shell),
    };
}

function workAreaWidth(shell) {
    try {
        let layout = shell.layout;
        let monitor = layout.findMonitorForActor
            ? layout.findMonitorForActor(shell.actor) : layout.primaryMonitor;
        let index = monitor?.index;
        if (typeof index === "number" && layout.getWorkAreaForMonitor) {
            let area = layout.getWorkAreaForMonitor(index);
            if (area?.width)
                return area.width;
        }
        return monitor?.width || 0;
    } catch (error) {
        return 0;
    }
}

/* The desktop's HiDPI multiplier. St applies it to every length in the
 * stylesheet, and the work area above is in the same magnified pixels. */
function scaleFactor(shell) {
    try {
        if (shell.global && shell.global.ui_scale)
            return shell.global.ui_scale;
        return shell.st.ThemeContext.get_for_stage(shell.global.stage)
            .scale_factor || 1;
    } catch (error) {
        return 1;
    }
}

/* Type magnified for somebody who needs it makes every row wider, and a
 * column is as wide as its longest row. */
function textScale(shell) {
    try {
        let Gio = shell.gio;
        let schema = "org.cinnamon.desktop.interface";
        let source = Gio.SettingsSchemaSource.get_default();
        if (source && !source.lookup(schema, true))
            return 1;
        return new Gio.Settings({ schema_id: schema })
            .get_double("text-scaling-factor") || 1;
    } catch (error) {
        return 1;
    }
}
