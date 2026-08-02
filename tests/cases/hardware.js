/*
 * What the hardware is called.
 *
 * Two tables, neither of which is guaranteed to be on the machine running
 * these: pci.ids, which turns a slot into a graphics card, and pnp.ids, which
 * turns three letters of EDID into a company. Both are read through IO, so the
 * fixture stands in for them and nothing here depends on what this particular
 * machine happens to have installed.
 */

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
