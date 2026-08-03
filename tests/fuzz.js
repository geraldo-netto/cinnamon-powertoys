/*
 * Fuzzing, for the parts of this applet that read something they did not
 * write.
 *
 * Most of what is here is a function of a machine: ddcutil's output, a sysfs
 * node, a UPower property, a name out of pci.ids, a fragment somebody typed
 * into a settings box. The cases beside this one pick the inputs, which means
 * they pick the inputs somebody thought of - and the failures that reach a bug
 * report are the ones nobody thought of, because a driver labelled a sensor
 * with a byte order mark or a monitor answered with an empty string where a
 * number goes.
 *
 * So these throw shapes at a function by the thousand and hold it to a
 * property rather than to an answer: that it does not throw, that what comes
 * back is in range, that an ordering is an ordering. A property is what can be
 * said about an input nobody has seen.
 *
 * Every run is the same run. The generator is seeded and the seed is part of
 * the case, because a fuzz failure that cannot be reproduced is a rumour - and
 * because a suite that finds a different bug on Tuesday is one people learn to
 * re-run rather than to read. A failure reports the seed and the input that
 * did it, which is enough to write the ordinary case that pins it.
 */

/*
 * A small linear congruential generator, which is enough for this and has the
 * one property that matters: the same seed is the same sequence, here, on the
 * build machine, and in a year.
 *
 * Math.random cannot be used for the reason above, and the numbers wanted here
 * are not the kind anything depends on being unguessable.
 */
var Random = class Random {
    constructor(seed) {
        this._state = (seed >>> 0) || 1;
    }

    /* 0 to 2^32-1. */
    next() {
        this._state = (this._state * 1664525 + 1013904223) >>> 0;
        return this._state;
    }

    /*
     * 0 to bound-1, from the top of the word rather than the bottom.
     *
     * The low bits of a linear congruential generator are not random: bit one
     * alternates, and the bottom k bits repeat every 2^k. Taking the remainder
     * reads exactly those, so `below(4)` returned 0, 1, 2, 3, 0, 1, 2, 3 - a
     * generator that walks in step through everything it is asked for, and a
     * property that had far fewer shapes thrown at it than its run count said.
     *
     * Scaling the whole word into the range reads the high bits instead, which
     * are the ones this family is any good at.
     */
    below(bound) {
        return bound <= 0 ? 0 : Math.floor(this.next() / 4294967296 * bound);
    }

    between(low, high) {
        return low + this.below(high - low + 1);
    }

    pick(items) {
        return items[this.below(items.length)];
    }

    /* True about one time in `odds`. */
    chance(odds) {
        return this.below(odds) === 0;
    }
};

/*
 * The characters worth throwing at something that reads text.
 *
 * Not "random bytes": what actually arrives is a kernel label, an EDID string,
 * a line of ddcutil, a fragment somebody typed. What breaks those is the
 * ordinary awkward - a colon where a name is split, a bracket where a name is
 * taken out of one, a backslash, a percent sign, a newline in the middle, and
 * the letters that are letters in a locale nobody tested in.
 */
var AWKWARD = [
    "", " ", "  ", "\t", "\n", "\r\n", ":", "::", "-", "_", ".", ",", "/", "\\",
    "(", ")", "[", "]", "{", "}", "%", "$", "&", "|", "*", "?", "+", "=", "<", ">",
    '"', "'", "`", "0", "00", "1", "-1", "0x10", "1e9", "NaN", "Infinity", "null",
    "undefined", " ", "﻿", "é", "中", "😀", "A", "z",
];

/* A string built out of those, of a length worth the trouble. */
function text(random, maximum) {
    let parts = [];
    let count = random.below(maximum === undefined ? 6 : maximum);
    for (let i = 0; i < count; i++)
        parts.push(random.pick(AWKWARD));
    return parts.join("");
}

/*
 * A number of the kind that turns up in a reading: the ordinary range, the
 * edges of it, and the values that are numbers to JavaScript and not to
 * anybody else.
 */
function number(random) {
    switch (random.below(10)) {
        case 0: return 0;
        case 1: return -0;
        case 2: return NaN;
        case 3: return Infinity;
        case 4: return -Infinity;
        case 5: return random.between(-1000, 1000) / 7;
        case 6: return Number.MAX_SAFE_INTEGER;
        case 7: return -Number.MAX_SAFE_INTEGER;
        case 8: return random.between(0, 100);
        default: return random.between(-2000000, 2000000);
    }
}

/* A number, a string that looks like one, or something else entirely - which
 * is the range of what a sysfs read or a D-Bus property can come back as. */
function value(random) {
    switch (random.below(6)) {
        case 0: return number(random);
        case 1: return String(number(random));
        case 2: return text(random);
        case 3: return null;
        case 4: return undefined;
        default: return random.chance(2);
    }
}

/*
 * Runs a property over generated inputs, and says what broke it.
 *
 * `generate` is handed the generator and answers one input; `property` is
 * handed that input and throws when it does not hold. What comes back on a
 * failure is the seed, the iteration and the input, which is what turns a
 * fuzz failure into an ordinary case.
 *
 * The count is deliberately modest. This runs on every `make check`, beside
 * three hundred other cases, and a suite people wait for is a suite people
 * stop running.
 */
function forAll(options, generate, property) {
    let settings = typeof options === "object" ? options : { what: options };
    let runs = settings.runs || 200;
    let seed = settings.seed || 20260803;
    let random = new Random(seed);

    for (let i = 0; i < runs; i++) {
        let input = generate(random);
        try {
            property(input, random);
        } catch (error) {
            throw new Error((settings.what || "the property") + " does not hold: " +
                            error.message + "\n        seed " + seed + ", run " + i +
                            ", input " + show(input));
        }
    }
}

/* An input as something that can be pasted into a case. */
function show(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (value === undefined)
        return "undefined";
    if (typeof value === "number")
        return String(value);
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
}

/* ---------------------------------------------------------------- */
/* properties that come up more than once                            */

/* Nothing here may throw at its caller: every one of these is called from a
 * poll, and a poll that throws takes the panel down with it. */
function answers(body) {
    let result;
    try {
        result = body();
    } catch (error) {
        throw new Error("threw " + error);
    }
    return result;
}

/* A string. Nothing here may hand a widget anything else: St draws what it is
 * given, and what it does with a number or a null is its own business. */
function isString(value, what) {
    if (typeof value !== "string")
        throw new Error((what || "the answer") + " is not a string: " + show(value));
    if (value.indexOf("[object") >= 0)
        throw new Error((what || "the answer") + " has an object printed into it: " + show(value));
}

/*
 * A string, and not a value's insides dressed up as one.
 *
 * For the functions that turn a number into text, where "NaN" or "undefined"
 * in the answer can only have come from this side. A function that passes a
 * label through - capitalize, the profile names - is held to isString instead,
 * since the label itself is allowed to contain any word at all, and one of the
 * strings this fuzzer throws about is literally "NaN".
 */
function isText(value, what) {
    isString(value, what);
    if (/undefined|NaN/.test(value))
        throw new Error((what || "the answer") + " has a value's insides in it: " + show(value));
}

/* A number in a range, or null where there is nothing to say. */
function inRange(value, low, high, what) {
    if (value === null)
        return;
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error((what || "the answer") + " is not a number: " + show(value));
    if (value < low || value > high)
        throw new Error((what || "the answer") + " is outside " + low + " to " + high +
                        ": " + show(value));
}
