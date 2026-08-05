/*
 * What the hardware is called.
 *
 * Two tables, neither of which is guaranteed to be on the machine running
 * these: pci.ids, which turns a slot into a graphics card, and pnp.ids, which
 * turns three letters of EDID into a company. Both are read through IO, so the
 * fixture stands in for them and nothing here depends on what this particular
 * machine happens to have installed.
 */

const Fuzz = imports.fuzz;
const Harness = imports.harness;

const Hardware = Harness.requireXlet("./lib/hardware.js");
const IO = Harness.requireXlet("./lib/io.js");

/* The names are cached on purpose, so a case that changes the machine has to
 * say so. */
function on(machine, body) {
    Hardware.forget();
    IO.setRoot(Harness.fixture(machine));
    try {
        return body();
    } finally {
        IO.setRoot("");
        Hardware.forget();
    }
}

var cases = {};

/* ---------------------------------------------------------------- */
/* processor                                                         */

cases["a processor is named without the words every processor has"] = function () {
    on("machine", function () {
        Harness.equal(Hardware.cpuModelName(), "AMD Ryzen 7 5800X",
                      "the core count and the word Processor are not the model");
    });
};

cases["the marketing in a model name comes off"] = function () {
    Harness.equal(Hardware.tidyCpuName("Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz"),
                  "Intel Core i7-8550U", "symbols, the word CPU and the clock");
    Harness.equal(Hardware.tidyCpuName("AMD Ryzen 9 7945HX with Radeon Graphics"),
                  "AMD Ryzen 9 7945HX", "what the graphics half is called is not the CPU");
    Harness.equal(Hardware.tidyCpuName("AMD Ryzen 5 3600 6-Core Processor"),
                  "AMD Ryzen 5 3600", "the core count is in /proc, not in the name");
    Harness.equal(Hardware.tidyCpuName("Cortex-A72"), "Cortex-A72", "nothing to take off");
    Harness.equal(Hardware.tidyCpuName(""), null, "nothing at all");
};

cases["a machine with no cpuinfo is not named rather than named wrongly"] = function () {
    on("inverted-boost", function () {
        Harness.equal(Hardware.cpuModelName(), null, "no /proc/cpuinfo in this fixture");
    });
};

/* ---------------------------------------------------------------- */
/* PCI                                                               */

cases["a device is named from pci.ids"] = function () {
    on("machine", function () {
        let names = Hardware.pciDeviceNames(["0000:03:00.0"]);
        Harness.equal(names["0000:03:00.0"], "Radeon RX 6600/6600 XT/6600M",
                      "the name on the box, not the codename in front of it");
    });
};

cases["a board is preferred to the chip on it"] = function () {
    on("machine", function () {
        let names = Hardware.pciDeviceNames(["0000:07:00.0"]);
        Harness.equal(names["0000:07:00.0"], "Intel Wireless-AC 9560",
                      "the subsystem names the card; its vendor is put in front");
    });
};

cases["an address with no entry is left unnamed"] = function () {
    on("machine", function () {
        let names = Hardware.pciDeviceNames(["0000:99:00.0"]);
        Harness.equal(names["0000:99:00.0"], undefined,
                      "absent rather than null, so a caller can fall back with ||");
    });
};

cases["a chip with only a codename gets its vendor in front of it"] = function () {
    Harness.equal(Hardware.deviceDisplayName("Raphael", "Advanced Micro Devices, Inc. [AMD/ATI]"),
                  "AMD Raphael", "a codename alone says nothing about whose it is");
    Harness.equal(Hardware.deviceDisplayName("Navi 23 [Radeon RX 6600/6600 XT/6600M]",
                                             "Advanced Micro Devices, Inc. [AMD/ATI]"),
                  "Radeon RX 6600/6600 XT/6600M",
                  "the bracketed name names its own vendor already");
};

cases["the alternatives in a shared name are kept"] = function () {
    /* pci.ids lists three cards there because one device id covers all three.
     * Cutting it to the first would be asserting a model the hardware has not
     * reported. */
    Harness.equal(Hardware.deviceDisplayName("Navi 23 [Radeon RX 6600/6600 XT/6600M]", "")
                      .indexOf("/") >= 0,
                  true, "the slashes are the point");
};

cases["a vendor is shortened to the part anyone recognises"] = function () {
    Harness.equal(Hardware.vendorShortName("Advanced Micro Devices, Inc. [AMD/ATI]"), "AMD",
                  "the bracket, and the first of the alternatives in it");
    Harness.equal(Hardware.vendorShortName("Intel Corporation"), "Intel", "the first word");
    Harness.equal(Hardware.vendorShortName("NVIDIA Corporation"), "NVIDIA", "the first word");
    Harness.equal(Hardware.vendorShortName(""), "", "nothing");
};

cases["an address is picked out of the path a sensor sits on"] = function () {
    Harness.equal(Hardware.pciAddressIn("../../../devices/pci0000:00/0000:03:00.0"),
                  "0000:03:00.0", "the device the driver bound to");
    Harness.equal(
        Hardware.pciAddressIn("/sys/devices/pci0000:00/0000:00:01.2/0000:04:00.0/nvme/nvme0"),
        "0000:04:00.0", "the last one, which is the nearest to the sensor");
    Harness.equal(Hardware.pciAddressIn("../../nvme0"), null, "nothing on the bus in that path");
    Harness.equal(Hardware.pciAddressIn(null), null, "no path at all");
};

cases["a missing table is not remembered as a missing device"] = function () {
    /* This fixture has no pci.ids, so the answer is "not known yet" and not
     * "there is no such card" - the table can be installed later. */
    on("inverted-boost", function () {
        Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"], undefined,
                      "nothing to look it up in");
    });
    on("machine", function () {
        Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"],
                      "Radeon RX 6600/6600 XT/6600M", "and it is found once there is");
    });
};

cases["an address that had nothing at it is asked about again"] = function () {
    /*
     * Only answers are remembered. That a slot has no name is a fact about
     * what was in it when somebody last looked, and a card plugged into it
     * later would otherwise keep showing the raw address for the session.
     */
    Hardware.forget();
    IO.setRoot(Harness.fixture("inverted-boost"));
    try {
        Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"], undefined,
                      "nothing there yet");
        IO.setRoot(Harness.fixture("machine"));
        Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"],
                      "Radeon RX 6600/6600 XT/6600M",
                      "and it is found without the cache having been dropped");
    } finally {
        IO.setRoot("");
        Hardware.forget();
    }
};

cases["a replacement at one PCI address gets its own name"] = function () {
    on("machine", function () {
        Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"],
                      "Radeon RX 6600/6600 XT/6600M", "the original card is cached");
        let originalReadString = IO.readString;
        IO.readString = function (path) {
            if (/\/0000:03:00\.0\/device$/.test(path))
                return "0x164e";
            return originalReadString(path);
        };
        try {
            Harness.equal(Hardware.pciDeviceNames(["0000:03:00.0"])["0000:03:00.0"],
                          "AMD Raphael", "new IDs invalidate the address's old name");
        } finally {
            IO.readString = originalReadString;
        }
    });
};

/* ---------------------------------------------------------------- */
/* monitors                                                          */

cases["an EDID code is turned into the name on the front of the monitor"] = function () {
    on("machine", function () {
        Harness.equal(Hardware.monitorVendorName("DEL"), "Dell", "Dell Inc. is Dell");
        Harness.equal(Hardware.monitorVendorName("GSM"), "LG", "LG Electronics is LG");
        Harness.equal(Hardware.monitorVendorName("AOC"), "AOC",
                      "a code nobody registered is already the brand");
        Harness.equal(Hardware.monitorVendorName(""), "", "nothing");
    });
};

cases["a maker is not said twice in a monitor's name"] = function () {
    on("machine", function () {
        Harness.equal(Hardware.monitorName("DEL", "DELL U2415"), "Dell U2415",
                      "the model already starts with the maker, so it is rewritten");
        Harness.equal(Hardware.monitorName("GSM", "LG HDR 4K"), "LG HDR 4K", "likewise");
        Harness.equal(Hardware.monitorName("AOC", "U27B3A"), "AOC U27B3A",
                      "and where it does not, the maker goes in front");
        Harness.equal(Hardware.monitorName("SAM", ""), "Samsung",
                      "a monitor that reports no model at all");
    });
};

cases["a company name is tidied to what is on the box"] = function () {
    Harness.equal(Hardware.tidyVendorName("Samsung Electric Company"), "Samsung", "two words off");
    Harness.equal(Hardware.tidyVendorName("Acer Technologies"), "Acer", "one word off");
    Harness.equal(Hardware.tidyVendorName("Hewlett Packard"), "Hewlett Packard",
                  "nothing to take off, and the second word is part of the name");
    Harness.equal(Hardware.tidyVendorName("Inc"), "Inc",
                  "the last word is never taken, or nothing is left");
};

/* ---------------------------------------------------------------- */
/* the table parsing, at its edges                                   */

cases["a block's name is what follows the two spaces"] = function () {
    /*
     * pci.ids separates an id from its name with exactly two spaces, and the
     * name is everything after them. A block is one line or many, and the
     * first line is the one that names it.
     */
    Harness.equal(Hardware._blockName("1002  Advanced Micro Devices"),
                  "Advanced Micro Devices", "a block of one line");
    Harness.equal(Hardware._blockName("1002  AMD\n\t164e  Raphael\n"), "AMD",
                  "and the first line of a block of several");
    Harness.equal(Hardware._blockName("1002 AMD"), "",
                  "one space is not the separator, so there is no name here");
    Harness.equal(Hardware._blockName("  starts with the separator"), "starts with the separator",
                  "a line that opens with it still has a name after it");
    Harness.equal(Hardware._blockName(""), "", "and nothing has none");
};

cases["a device block ends where the next unindented line begins"] = function () {
    /*
     * Devices are one tab in and their subsystems two, so a device's own block
     * runs to the next line that is not two tabs in. Taking one character too
     * few loses the newline the next search needs; one too many swallows the
     * device after it, and its subsystems with it.
     */
    let vendor = "1002  AMD\n" +
                 "\t73ff  Navi 23\n" +
                 "\t\t1849 5001  Phantom Gaming\n" +
                 "\t164e  Raphael\n";

    let navi = Hardware._deviceBlock(vendor, "73ff");
    Harness.equal(navi.indexOf("73ff  Navi 23") >= 0, true, "the device is in it");
    Harness.equal(navi.indexOf("1849 5001") >= 0, true, "and its subsystem with it");
    Harness.equal(navi.indexOf("Raphael"), -1, "and not the device after it");

    let raphael = Hardware._deviceBlock(vendor, "164e");
    Harness.equal(raphael.indexOf("Raphael") >= 0, true, "the last device runs to the end");
    Harness.equal(Hardware._deviceBlock(vendor, "ffff"), null, "and one that is not there is null");

    /* A block whose very first character starts the device, which is what a
     * search finding position nought means. */
    let leading = "\n\t73ff  Navi 23\n";
    Harness.ok(Hardware._deviceBlock(leading, "73ff") !== null,
               "a device at the very start of a block is still found");
};

cases["a subsystem is only used where the device really has one"] = function () {
    /*
     * A subsystem id names the card somebody bought - "Phantom Gaming Radeon
     * RX 6600" - where the device id names only the chip on it. Most cards are
     * not in the table under their subsystem, and a card whose subsystem
     * vendor is 0000 has none at all, so all three parts have to be there
     * before the lookup is worth making.
     */
    on("machine", function () {
        let text = IO.readString("/usr/share/misc/pci.ids");

        let board = Hardware._resolve(text, { vendor: "1002", device: "73ff",
                                              subVendor: "1849", subDevice: "5001" });
        Harness.equal(board, "ASRock Phantom Gaming Radeon RX 6600",
                      "the board, with the maker in front of it");

        let chip = Hardware._resolve(text, { vendor: "1002", device: "73ff",
                                             subVendor: null, subDevice: null });
        Harness.equal(chip, "Radeon RX 6600/6600 XT/6600M", "no subsystem, so the chip");

        let unnamed = Hardware._resolve(text, { vendor: "1002", device: "73ff",
                                                subVendor: "0000", subDevice: "0000" });
        Harness.equal(unnamed, "Radeon RX 6600/6600 XT/6600M",
                      "a subsystem vendor of nought names nobody");

        let halfway = Hardware._resolve(text, { vendor: "1002", device: "73ff",
                                                subVendor: "1849", subDevice: null });
        Harness.equal(halfway, "Radeon RX 6600/6600 XT/6600M", "half a subsystem is not one");

        let vendorOnly = Hardware._resolve(text, { vendor: "1002", device: "ffff",
                                                   subVendor: null, subDevice: null });
        Harness.equal(vendorOnly, "AMD",
                      "a device nobody has heard of still knows whose it is");

        Harness.equal(Hardware._resolve(text, { vendor: "ffff", device: "0001" }), null,
                      "and a vendor nobody has heard of is nothing at all");
    });
};

cases["a board that already names its maker does not name it twice"] = function () {
    on("machine", function () {
        let text = IO.readString("/usr/share/misc/pci.ids");
        /* XFX Limited's own entry, where the board name opens with the maker.
         * Prefixing it again would draw "XFX XFX Speedster". */
        let name = Hardware._resolve(text, { vendor: "1002", device: "73ff",
                                             subVendor: "1eae", subDevice: "9999" });
        Harness.equal(name, "Radeon RX 6600/6600 XT/6600M",
                      "no subsystem entry for that pair, so the chip stands");
    });
};

cases["one address asked about twice is looked up once"] = function () {
    /*
     * The sensor sweep hands over one address per chip, and a machine with a
     * graphics card that reports temperatures, fans and power hands over the
     * same address three times. Reading the table again for each would be
     * 1.4 MB three times over.
     */
    on("machine", function () {
        let reads = 0;
        let real = IO.readString;
        IO.readString = function (path) {
            if (path.indexOf("pci.ids") >= 0)
                reads++;
            return real(path);
        };
        try {
            let names = Hardware.pciDeviceNames(
                ["0000:03:00.0", "0000:03:00.0", "0000:03:00.0"]);
            Harness.equal(reads, 1, "the table was read once");
            Harness.equal(Object.keys(names).length, 1, "and one address is one answer");

            Hardware.pciDeviceNames(["0000:03:00.0"]);
            Harness.equal(reads, 1, "the same IDs reuse the resolved name");
        } finally {
            IO.readString = real;
        }
    });
};

cases["an address that is nothing at all is not looked up"] = function () {
    on("machine", function () {
        let names = Hardware.pciDeviceNames([null, "", undefined]);
        Harness.deepEqual(names, {}, "nothing to name");
    });
};

/* ---------------------------------------------------------------- */
/* names, at their edges                                             */

cases["the first word of a company name is not dropped as a company word"] = function () {
    /*
     * The words dropped from a registered name are the ones every registered
     * name has - Inc, Ltd, Electronics - and they are dropped from the end.
     * A name that is only one of those words is that company's whole name and
     * has to stay, or a monitor ends up made by nobody.
     */
    Harness.equal(Hardware.tidyVendorName("Dell Inc."), "Dell", "the suffix goes");
    Harness.equal(Hardware.tidyVendorName("LG Electronics Inc."), "LG", "and two of them go");
    Harness.equal(Hardware.tidyVendorName("Inc"), "Inc",
                  "a name that is nothing but a company word is still the name");
    Harness.equal(Hardware.tidyVendorName("Samsung Electric Company"), "Samsung", "tidied");
    Harness.equal(Hardware.tidyVendorName(""), "", "and nothing stays nothing");
};

cases["a monitor with only half a name is named by that half"] = function () {
    Harness.equal(Hardware.monitorName("", "U2415"), "U2415",
                  "no maker, so the model is the name");
    Harness.equal(Hardware.monitorName("DEL", ""), "Dell",
                  "no model, so the maker is");
    Harness.equal(Hardware.monitorName("", ""), "", "and neither is nothing");
};

cases["a model that already opens with its maker is left alone"] = function () {
    /* EDID strings are written by whoever assembled the monitor, and some of
     * them repeat the maker. "Dell Dell U2415" is the failure. */
    Harness.equal(Hardware.monitorName("DEL", "DELL U2415"), "Dell U2415",
                  "the code at the front is replaced by the name");
    Harness.equal(Hardware.monitorName("DEL", "Dell U2415"), "Dell U2415",
                  "and the name at the front is left where it is");
    Harness.equal(Hardware.monitorName("DEL", "U2415"), "Dell U2415",
                  "while a model that says nothing about its maker gets one");
};

/* ---------------------------------------------------------------- */
/* names nobody here wrote                                           */

/*
 * Every name in this file comes off hardware or out of a table shipped by
 * somebody else: EDID strings are written by whoever assembled the monitor,
 * and pci.ids is a text file the distribution updates. Both are read, not
 * written, and both turn up truncated, in the wrong encoding, or with a field
 * somebody left empty.
 *
 * What is held here is that a name comes back a string with something in it,
 * and never a value's insides: "undefined Dell" in a menu is this side's
 * mistake, whatever the monitor said.
 */

cases["a company name is tidied down to a name, whatever it was"] = function () {
    Fuzz.forAll({ what: "tidyVendorName", runs: 600 },
                random => (random.chance(3) ? Fuzz.text(random, 5)
                                            : Fuzz.text(random, 2) + " " +
                                              random.pick(["Inc.", "Ltd", "Electronics",
                                                           "Corporation", "Co.,", "GmbH"])),
                function (input) {
                    let out = Fuzz.answers(() => Hardware.tidyVendorName(input));
                    Fuzz.isString(out, "the tidied name");
                    Harness.ok(out.length <= input.length + 1,
                               "tidying does not grow a name: " + JSON.stringify(out));
                });
};

cases["a monitor ends up with a name whatever its EDID says"] = function () {
    /*
     * The two halves come from different places - the code from a table, the
     * model from the monitor - and either can be missing, empty or nonsense.
     * The row still needs a title.
     */
    on("machine", function () {
        Fuzz.forAll({ what: "monitorName", runs: 400 }, function (random) {
            return {
                code: random.chance(3) ? random.pick(["DEL", "GSM", "AOC", "SAM", "XXX"])
                                       : Fuzz.text(random, 3),
                model: random.chance(4) ? "" : Fuzz.text(random, 4),
            };
        }, function (input) {
            /* isString rather than isText: the model is passed through from
             * the monitor, and one of the strings this fuzzer throws about is
             * literally "undefined". */
            let name = Fuzz.answers(() => Hardware.monitorName(input.code, input.model));
            Fuzz.isString(name, "the monitor name");
            if (input.model.trim().length > 0)
                Harness.ok(name.trim().length > 0,
                           "a monitor that said something has a name: " + JSON.stringify(name));
        });
    });
};

cases["a block of a table is read for its name, whatever is in the block"] = function () {
    /*
     * pci.ids is 1.4 MB of two-space separated names, and a truncated download
     * or a line the format grew is a block that does not look like one. The
     * name of a block that says nothing is nothing, and never a slice taken
     * past the end of it.
     */
    Fuzz.forAll({ what: "the block name", runs: 500 }, function (random) {
        let lines = [];
        let count = random.below(4);
        for (let i = 0; i < count; i++)
            lines.push(random.pick(["", "\t", "\t\t"]) + Fuzz.text(random, 3) +
                       random.pick(["  ", " ", ":", ""]) + Fuzz.text(random, 3));
        return lines.join("\n");
    }, function (input) {
        let name = Fuzz.answers(() => Hardware._blockName(input));
        Fuzz.isString(name, "the block name");
        Harness.equal(name.indexOf("\n"), -1, "one line's worth of it: " + JSON.stringify(name));
    });
};
