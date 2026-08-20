/*
 * What a sensor is, what it is called, and where it sorts.
 *
 * None of this opens a file. It is the judgement applied to what the sysfs
 * sweep found: which of eight kinds a chip belongs to, whether that kind is
 * interesting enough for the short list, the order two readings go in, whether
 * a sensor answers to what somebody typed in the preferred-sensor box, and the
 * two names every reading carries - the long one for a list of everything and
 * the short one for a row under a heading that already names the chip.
 *
 * It was the first third of lib/sensors.js, which is also a sysfs sweep and
 * three runtime objects, so the naming rules could only be read past on the way
 * to something else.
 */

const Format = require("./lib/format.js");
const Hardware = require("./lib/hardware.js");
const IO = require("./lib/io.js");
const Naming = require("./lib/naming.js");
const Translate = require("./lib/gettext.js");

const _ = Translate._;

/*
 * What a sensor can be, said once.
 *
 * Each kind carries everything anyone needs to know about it: the chip name
 * prefixes that select it, the name it is shown under, whether it is worth
 * listing when the menu is not asked for every sensor on the machine, and -
 * as the position in this array - where it sorts. Keeping those apart is how
 * "package" came to exist in the sort order and nowhere else.
 *
 * The order is the display order, and a chip is classified by the first
 * pattern that matches it, so a more specific kind has to come first. The two
 * kinds without a pattern are never guessed from a chip name: "package" is
 * what the powercap counters report, "other" is what is left.
 */
const KINDS = [
    { kind: "cpu",     primary: true,  label: _("Processor"),
      pattern: /^(k10temp|zenpower|coretemp|cpu_thermal|cpu-thermal|x86_pkg_temp|soc_thermal|cpu\d*_thermal)/i },
    { kind: "gpu",     primary: true,  label: _("Graphics"),
      pattern: /^(amdgpu|radeon|nouveau|nvidia|i915|xe|gpu_thermal|gpu-thermal)/i },
    { kind: "package", primary: true,  label: _("Package"),   pattern: null },
    { kind: "battery", primary: true,  label: _("Battery"),
      pattern: /^(bat\d*|bq\d|max\d{4}|rt\d{4})/i },
    { kind: "board",   primary: false, label: _("Mainboard"),
      pattern: /^(acpitz|pch_|nct\d|it87|thinkpad|asus|dell_smm|gigabyte|corsair)/i },
    { kind: "disk",    primary: false, label: _("Storage"),
      pattern: /^(nvme|drivetemp)/i },
    { kind: "network", primary: false, label: _("Network"),
      pattern: /^(iwlwifi|ath\d*k|mt79|mt76|rtw|brcm|r8\d{3}|igb|igc|e1000|ixgbe)/i },
    { kind: "other",   primary: false, label: _("Other"),     pattern: null },
];

function _kind(name) {
    return KINDS.find(entry => entry.kind === name) || null;
}

function classifyChip(name) {
    for (let entry of KINDS) {
        if (entry.pattern?.test(name))
            return entry.kind;
    }
    return "other";
}

function kindLabel(kind) {
    let entry = _kind(kind);
    return entry ? entry.label : _kind("other").label;
}

/* Whether the kind survives the "only the interesting ones" menu filter. */
function isPrimaryKind(kind) {
    let entry = _kind(kind);
    return entry ? entry.primary : false;
}

/* Sort position; anything unrecognised goes last. */
function kindRank(kind) {
    let index = KINDS.findIndex(entry => entry.kind === kind);
    return index < 0 ? KINDS.length : index;
}

/*
 * Whether a sensor answers to a name, judged on what the kernel calls it.
 *
 * Deliberately not the menu name: that one is composed for reading - the chip
 * prefixed, a disambiguating suffix appended - and changing how it is built
 * would silently change which sensor anything matching on it picks. These are
 * the driver's own words, and a thermal zone that has no label of its own is
 * matched on its type.
 */
function sensorMatches(sensor, fragment) {
    if (!fragment)
        return false;
    let wanted = fragment.toLowerCase();
    return (sensor.rawLabel || "").toLowerCase().includes(wanted) ||
           (sensor.chip || "").toLowerCase().includes(wanted);
}

/*
 * Everything one chip has to say, together.
 *
 * Kind first, so the processor's readings are in one place and the graphics
 * card's in another; then temperature, fan, power within a kind, because that
 * is the order of interest; then by name. Sorting the three measures
 * separately would have put a card's fan speed several rows below its
 * temperature with another chip's readings in between.
 *
 * A reading with no measure - which is anything sorted before the three lists
 * are joined - falls through to the name, which is what this did before the
 * measure was part of it.
 */
const MEASURE_ORDER = ["temperature", "fan", "power"];

function bySensorOrder(a, b) {
    let byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind !== 0)
        return byKind;
    /*
     * Then by which chip it came off, so that two graphics cards are two
     * blocks rather than one interleaved list. Natural order, so hwmon9 comes
     * before hwmon10 and the discrete card - which the kernel numbers first -
     * stays above the one in the processor.
     */
    let byGroup = IO.naturalCompare(a.group || "", b.group || "");
    if (byGroup !== 0)
        return byGroup;
    let byMeasure = MEASURE_ORDER.indexOf(a.measure) - MEASURE_ORDER.indexOf(b.measure);
    if (byMeasure !== 0)
        return byMeasure;
    if (a.label === b.label)
        return 0;
    return a.label < b.label ? -1 : 1;
}

/*
 * What a sensor is called under a heading that already names the chip.
 *
 * "amdgpu edge" is two words of which one is the heading, so the chip comes
 * off. What is left is the driver's own word for the reading, which is a word
 * to whoever wrote the driver and a riddle to everyone else. The ones below
 * are spelled out; everything else is passed through with a capital on it,
 * because guessing at a name is worse than showing the one the kernel uses.
 *
 * A reading the driver never labelled is named after what it measures, which
 * under the chip's own heading is all there is left to say about it.
 *
 * The processor's three keep the driver's word in brackets after the spelled
 * out one. It is the string the preferred-sensor setting is matched against,
 * and this row is the only place in the applet it is ever written, so a name
 * that replaced it would leave nothing to copy into that box.
 *
 * What they mean is the kernel's. From Documentation/hwmon/k10temp.rst: Tctl
 * is "the processor temperature control value, used by the platform to
 * control cooling systems", on an arbitrary scale rather than a physical one;
 * Tdie is the temperature actually measured; Tccd1..8 are the Core Complex
 * Dies, the chiplets the cores sit on.
 *
 * From amdgpu, where the labels are a table in amdgpu_pm.c and each entry is
 * read in amdgpu_hwmon_show_temp: "junction" asks the card for
 * AMDGPU_PP_SENSOR_HOTSPOT_TEMP, so it is the hotspot, which is the name the
 * rest of the world uses for it; "edge" asks for AMDGPU_PP_SENSOR_EDGE_TEMP,
 * away from that hotspot; "mem" is the memory on the card. vddnb is the one
 * the driver refuses on anything but an APU - "only APUs have vddnb" - and it
 * is that chip's SoC rail.
 *
 * Each entry answers with the name rather than being a replacement string.
 * These are translated, and a replacement string is not text: `$&`, `$1` and
 * `$'` are substitutions to String.replace, so a translator who wrote a `$`
 * got it eaten or got part of the label repeated back at them. The entries
 * that quote the driver back ask the match for it instead, which also keeps
 * the driver's own capitals.
 */
const SHORT_LABELS = [
    [/^tccd(\d+)$/i, match => Translate.interpolate(
        _("Core die %{number} (%{token})"), { number: match[1], token: match[0] })],
    [/^tccd$/i, match => Translate.interpolate(
        _("Core die (%{token})"), { token: match[0] })],
    [/^tdie$/i, match => Translate.interpolate(
        _("Measured die (%{token})"), { token: match[0] })],
    [/^tctl$/i, match => Translate.interpolate(
        _("Cooling control (%{token})"), { token: match[0] })],
    [/^edge$/i, () => _("Die edge")],
    [/^junction$/i, () => _("Hotspot")],
    [/^mem$/i, () => _("Memory")],
    [/^vddgfx$/i, () => _("Core voltage")],
    [/^vddnb$/i, () => _("SoC voltage")],
    [/^ppt$/i, () => _("Power")],
];

function _shortName(entry) {
    let label = entry.rawLabel;
    if (!label) {
        let measure = Format.measureName(entry.measure) || entry.chip;
        return entry.siblings > 1 ? measure + " " + entry.index : measure;
    }

    if (label.toLowerCase().indexOf(entry.chip.toLowerCase()) === 0)
        label = label.slice(entry.chip.length).trim() || label;

    for (let [pattern, name] of SHORT_LABELS) {
        let match = pattern.exec(label);
        if (match)
            return name(match);
    }
    return Format.capitalize(label);
}

/* "k10temp Tctl" rather than "Tctl", and "drivetemp 1" where a chip has
 * several of something and names none of them. */
function _displayName(entry) {
    let chip = entry.chip;
    let label = entry.rawLabel;
    if (!label)
        return entry.siblings > 1 ? chip + " " + entry.index : chip;
    if (label.toLowerCase().indexOf(chip.toLowerCase()) === 0)
        return label;
    return chip + " " + label;
}

/*
 * Names everything discovered, in one pass, without touching what it was
 * given: an entry comes back as a copy carrying `display`.
 *
 * Where that name would be ambiguous - five drivetemp chips all called
 * "drivetemp" - whatever tells them apart is appended: the block device, the
 * PCI slot, the thermal zone.
 *
 * Ambiguity is judged within a measure and not across all of them. Two
 * readings from one card, a fan and a power meter, are both "amdgpu", and
 * appending the same PCI slot to each would leave them just as alike and
 * longer; they are already told apart by being in RPM and in watts.
 */
function finalizeNames(entries) {
    let displays = Naming.disambiguate(entries, {
        name: entry => _displayName(entry),
        scope: entry => entry.measure,
    });
    return entries.map((entry, index) => ({ ...entry,
        display: displays[index],
        short: _shortName(entry),
    }));
}

/*
 * What the chip a reading came off is called, in the words somebody would use
 * for it.
 *
 * The kernel identifies a chip by its driver and its address - "amdgpu" at
 * 03:00.0 - and neither says which of the two cards in the machine it is. The
 * processor is named from /proc/cpuinfo and anything on the PCI bus from
 * pci.ids; a chip that is on neither keeps the driver's own name, which is at
 * least the name its documentation uses.
 *
 * The address is still the answer when there is no table to look it up in,
 * because a name that cannot be found is not a reason to show nothing.
 */
function _groupName(entry, pciNames, cpuName) {
    if (entry.kind === "cpu" && cpuName)
        return cpuName;
    if (entry.pciAddress && pciNames[entry.pciAddress])
        return pciNames[entry.pciAddress];
    return entry.chip;
}

/*
 * Names every group, and tells apart the ones that came out alike.
 *
 * Two identical cards resolve to one name, and two headings reading "Radeon RX
 * 6600" over different numbers is worse than no heading at all, so whatever
 * told the chips apart in the first place is appended - the PCI slot, the
 * block device, the thermal zone.
 */
function nameGroupsFrom(groups, cpuName, pciNames) {
    let names = Naming.disambiguate(groups, {
        name: group => _groupName(group, pciNames, cpuName),
    });
    let labels = {};
    groups.forEach((group, index) => { labels[group.key] = names[index]; });
    return labels;
}

function nameGroups(groups) {
    return nameGroupsFrom(groups, Hardware.cpuModelName(),
                           Hardware.pciDeviceNames(groups.map(group => group.pciAddress)));
}

