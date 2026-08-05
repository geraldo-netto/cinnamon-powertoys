/* Project operations that are declarative Make recipes rather than loadable
 * code. Hold their ordering to the safety property the command depends on. */

const Harness = imports.harness;

var cases = {};

cases["RAPL uninstall gives remaining udev rules the final say"] = function () {
    let source = Harness.readFile(Harness.testsDir() + "/../Makefile");
    let start = source.indexOf("uninstall-rapl:");
    let end = source.indexOf("\ncheck:", start);
    let recipe = source.slice(start, end);

    let remove = recipe.indexOf('rm -f -- "$(RAPL_DIR)/$(RAPL_RULE)"');
    let reload = recipe.indexOf("udevadm control --reload");
    let reset = recipe.indexOf('chgrp root "$$f"; chmod 0400 "$$f"');
    let trigger = recipe.indexOf("udevadm trigger --subsystem-match=powercap");
    Harness.ok(remove >= 0 && reload > remove, "the applet rule is removed before reload");
    Harness.ok(reset > reload, "the conservative fallback is applied after that rule is gone");
    Harness.ok(trigger > reset,
               "remaining distribution and administrator rules run after the fallback");
};
