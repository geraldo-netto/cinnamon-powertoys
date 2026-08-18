/*
 * cinnamon-powertoys - how many columns of menu fit on the screen.
 *
 * The menu is three columns of a subject each, and three columns have a floor:
 * every visible one asks for at least COLUMN_MINIMUM, so the popup starts at
 * three times that plus its own padding and the panel's border before a single
 * reading is drawn. On a 1024-wide netbook, at 200% scale, or with the desktop
 * text scaling turned up for someone who needs it, that is most of the screen
 * or more of it than there is.
 *
 * So the number across is decided from the room there actually is. What that
 * decision needs is arithmetic on five numbers, which is why it is here and
 * not in the widget: the menu applies the answer, and this is the only thing
 * that has to be right about it.
 *
 * A column that does not fit is not dropped - nothing is ever hidden to make
 * the menu fit, because a reading nobody can reach is worse than a tall menu.
 * It moves to the next shelf down, which is why the answer is a count and not
 * a visibility.
 */

/*
 * The width a column asks for, matching the `min-width` on `.powertoys-panel`
 * in the stylesheet - one number in two languages, and a case in
 * tests/cases/menu-layout.js fails if they stop agreeing.
 */
const COLUMN_MINIMUM = 210;

/*
 * What the popup costs before any column does: its own left and right padding,
 * the border, and the margin a menu keeps from the edge of the work area. An
 * estimate deliberately on the generous side - being one column narrower than
 * it had to be is a menu that still works, and being one wider is a menu with
 * a column off the side of the screen.
 */
const MENU_CHROME = 64;

/* Below this there is no arrangement worth calculating: one column, and the
 * menu scrolls. */
const MINIMUM_USABLE_WIDTH = 120;

function _positive(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value : fallback;
}

/*
 * How wide one column really is on this screen.
 *
 * The scale factor is the desktop's HiDPI multiplier, which St applies to
 * every length in the stylesheet - so a 210px column is 420 physical pixels at
 * 200%, and the work area is in those same physical pixels. Text scaling is
 * separate and multiplies only the type, but a column is as wide as its
 * longest line of type, so it moves the floor as well.
 */
function columnWidth(constraints) {
    let settings = constraints || {};
    let scale = _positive(settings.scaleFactor, 1);
    let text = _positive(settings.textScale, 1);
    let minimum = _positive(settings.columnMinimum, COLUMN_MINIMUM);
    return minimum * scale * text;
}

/*
 * How many columns to put side by side, between one and however many there
 * are to show.
 *
 * Never more than there are: two visible columns on a wide screen are two
 * across, not three with a gap where the third would have been.
 */
function columnsAcross(constraints) {
    let settings = constraints || {};
    let visible = Math.max(0, Math.floor(_positive(settings.visibleColumns, 0)));
    if (visible <= 1)
        return visible;

    let available = _positive(settings.availableWidth, 0) -
                    Math.max(0, _positive(settings.chrome, MENU_CHROME));
    if (!(available > MINIMUM_USABLE_WIDTH))
        return 1;

    let fits = Math.floor(available / columnWidth(settings));
    if (!Number.isFinite(fits) || fits < 1)
        return 1;
    return Math.min(visible, fits);
}

/*
 * The arrangement as the two boxes that hold it.
 *
 * The columns are never re-parented - moving actors between containers at
 * runtime would take the keyboard order and the menu's own idea of what is in
 * it with them. Instead they sit in two shelves that are always in the same
 * order, and both the outer box and the first shelf are turned between
 * horizontal and vertical:
 *
 *   three across   outer horizontal, shelf horizontal   [1 2][3]
 *   two across     outer vertical,   shelf horizontal   [1 2]
 *                                                       [3]
 *   one across     outer vertical,   shelf vertical     [1][2][3]
 *
 * `stacked` is what the divider needs to know: a rule between columns is a
 * vertical line beside them when they are side by side, and there is nothing
 * for it to divide when they are not.
 */
function shelfPlan(across) {
    let columns = Math.max(1, Math.floor(across) || 1);
    return {
        across: columns,
        outerVertical: columns < 3,
        shelfVertical: columns < 2,
        stacked: columns < 2,
    };
}

/* The whole answer, from the room there is to the boxes that hold it. */
function plan(constraints) {
    return shelfPlan(columnsAcross(constraints));
}
