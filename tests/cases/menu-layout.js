/*
 * How many columns of menu fit.
 *
 * Three columns of at least 210px each, plus the popup's own padding, is a
 * menu 630px wide before a reading is drawn - and twice that at 200% scale.
 * What is worth pinning down here is that the arrangement follows the room
 * there is, that it never invents columns that are not there, and that nothing
 * is ever dropped to make it fit: a column that has no room beside the others
 * goes below them.
 */

const Harness = imports.harness;

const MenuLayout = Harness.requireXlet("./lib/menu-layout.js");

/* A wide 1080p work area with nothing magnified. */
function room(parts) {
    return Object.assign({
        availableWidth: 1920,
        scaleFactor: 1,
        textScale: 1,
        visibleColumns: 3,
    }, parts || {});
}

var cases = {};

cases["a wide screen gets every column side by side"] = function () {
    Harness.equal(MenuLayout.columnsAcross(room()), 3, "all three fit at 1920");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 1024 })), 3,
                  "and still fit on a 1024 netbook at 100%");
};

cases["a narrow screen reflows to two columns and then to one"] = function () {
    /* Three columns need 630 plus the popup's own chrome, so a work area a
     * little under 700 is where the third one goes to the shelf below. */
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 694 })), 3,
                  "694 is just enough for all three");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 680 })), 2,
                  "680 is not, so the third moves down rather than off the screen");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 400 })), 1,
                  "400 has room for one");
};

cases["magnifying the desktop takes room away from the columns"] = function () {
    /* A 1920 screen at 200% is 1920 magnified pixels wide and a column asks
     * for 420 of them, so the same screen that held three now holds three -
     * and one at 1280 holds two. */
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 1280, scaleFactor: 2 })), 2,
                  "two columns at 200% on a 1280 work area");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 800, scaleFactor: 2 })), 1,
                  "and one where two would not fit");
};

cases["larger text takes room away too"] = function () {
    /* Text scaling multiplies only the type, but a column is as wide as its
     * longest line of it. */
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 900 })), 3,
                  "three at the default text size");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 900, textScale: 1.5 })), 2,
                  "two once the type is half again as large");
    Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: 900, textScale: 2.5 })), 1,
                  "and one for somebody who needs it much larger");
};

cases["never more columns than there are to show"] = function () {
    Harness.equal(MenuLayout.columnsAcross(room({ visibleColumns: 2 })), 2,
                  "two visible columns on a wide screen are two across");
    Harness.equal(MenuLayout.columnsAcross(room({ visibleColumns: 1 })), 1,
                  "and one is one");
    Harness.equal(MenuLayout.columnsAcross(room({ visibleColumns: 0 })), 0,
                  "a menu with no columns arranges none");
};

cases["a width the shell will not answer for is one column, not none"] = function () {
    for (let width of [0, -100, null, undefined, NaN]) {
        Harness.equal(MenuLayout.columnsAcross(room({ availableWidth: width })), 1,
                      "an unusable width of " + width + " still draws the menu");
    }
    Harness.equal(MenuLayout.columnsAcross(null), 0, "and no constraints at all is empty");
};

cases["a scale the shell will not answer for is treated as none"] = function () {
    Harness.equal(MenuLayout.columnWidth({ scaleFactor: 0, textScale: null }), 210,
                  "an absent multiplier does not collapse the column to nothing");
    Harness.equal(MenuLayout.columnWidth({ scaleFactor: 2, textScale: 1.5 }), 630,
                  "and the two that are there multiply together");
};

cases["the arrangement is two boxes turned, never a column moved"] = function () {
    let wide = MenuLayout.shelfPlan(3);
    Harness.equal(wide.outerVertical, false, "three across is one row of shelves");
    Harness.equal(wide.shelfVertical, false, "with the first shelf across too");
    Harness.equal(wide.stacked, false, "and the rules between them are vertical");

    let middle = MenuLayout.shelfPlan(2);
    Harness.equal(middle.outerVertical, true, "two across puts the shelves under each other");
    Harness.equal(middle.shelfVertical, false, "while the first shelf keeps its pair side by side");

    let narrow = MenuLayout.shelfPlan(1);
    Harness.equal(narrow.outerVertical, true, "one across is everything under everything");
    Harness.equal(narrow.shelfVertical, true, "including the pair on the first shelf");
    Harness.equal(narrow.stacked, true, "and the division between them is the rule above");
};

cases["an arrangement is always at least one column wide"] = function () {
    for (let across of [0, -1, null, undefined, NaN])
        Harness.equal(MenuLayout.shelfPlan(across).across, 1,
                      "a plan for " + across + " columns still draws one");
};

cases["the whole answer is the room turned into boxes"] = function () {
    Harness.deepEqual(MenuLayout.plan(room()), MenuLayout.shelfPlan(3),
                      "a wide screen plans three across");
    Harness.deepEqual(MenuLayout.plan(room({ availableWidth: 400 })), MenuLayout.shelfPlan(1),
                      "and a narrow one plans a stack");
};

cases["the column floor is one number in two languages"] = function () {
    let css = Harness.readFile(Harness.xletDir() + "/stylesheet.css");
    let match = /\.powertoys-panel \{[\s\S]*?min-width: (\d+)px;/.exec(css);
    Harness.ok(match !== null, "the column rule states a minimum width");
    Harness.equal(Number(match[1]), MenuLayout.COLUMN_MINIMUM,
                  "the width the stylesheet asks for is the width the arithmetic assumes");
};

/*
 * The two properties that make the reflow safe rather than merely possible.
 *
 * Order is what the keyboard walks and what a screen reader reads, and an
 * applet that rearranged those under the user would be worse than one that is
 * simply too wide. So the arrangement is boxes turned, and never a column
 * taken out of one container and put into another - which is a thing that can
 * be read off the source of a file no case can load.
 */
cases["the menu turns boxes and never moves a column"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/ui/menu.js");

    Harness.ok(source.indexOf("this._columns.actor.set_vertical(plan.outerVertical)") >= 0,
               "the outer box follows the plan");
    Harness.ok(source.indexOf("this._shelves[0].actor.set_vertical(plan.shelfVertical)") >= 0,
               "and so does the shelf holding the first pair");

    let apply = /_applyLayout\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(apply !== null, "the arrangement is applied in one place");
    for (let forbidden of ["remove_child", "remove_actor", "removeMenuItem", "destroy("]) {
        Harness.equal(apply[1].indexOf(forbidden), -1,
                      "rearranging must not " + forbidden + " a column");
    }

    /* The columns are built in one order, once. */
    let list = /this\._columnList = \[([^\]]*)\]/.exec(source);
    Harness.ok(list !== null, "the columns are one fixed list");
    Harness.deepEqual(list[1].split(",").map(name => name.trim()),
                      ["this._performanceColumn", "this._deviceColumn", "this._sensorColumn"],
                      "in the order they answer to each other, whatever the arrangement");
};

cases["the applet measures the room before the menu is shown"] = function () {
    let source = Harness.shellSource();
    let opened = /_onMenuOpened\(\) \{([\s\S]*?)\n    \}/.exec(source);
    Harness.ok(opened !== null, "the menu-open handler is present");
    Harness.ok(opened[1].indexOf("syncLayout(this._menuConstraints())") >= 0,
               "the arrangement is decided from the room there is now");

    /* Each of these is a shell interface that has changed shape before, and a
     * menu that fails to open is worse than a menu that is too wide. */
    for (let name of ["_workAreaWidth", "_scaleFactor", "_textScale"]) {
        let body = new RegExp(name + "\\(\\) \\{([\\s\\S]*?)\\n    \\}").exec(source);
        Harness.ok(body !== null, name + " is present");
        Harness.ok(body[1].indexOf("catch") >= 0,
                   name + " cannot stop the menu opening");
    }
};

cases["a visible column moving between rows changes what divides it"] = function () {
    let source = Harness.readFile(Harness.xletDir() + "/ui/menu.js");
    let apply = /_applyLayout\(\) \{([\s\S]*?)\n    \}/.exec(source)[1];
    Harness.ok(apply.indexOf("powertoys-panel-divided") >= 0, "the vertical rule is applied");
    Harness.ok(apply.indexOf("powertoys-panel-stacked") >= 0, "and the horizontal one");
    Harness.ok(apply.indexOf("column.shelf === index") >= 0,
               "which row a column is on comes from its shelf, not from its position");

    let css = Harness.readFile(Harness.xletDir() + "/stylesheet.css");
    Harness.ok(/\.powertoys-panel-stacked \{[\s\S]*?border-top:/.test(css),
               "a column below another is divided by the rule above it");
};
