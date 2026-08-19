/* Telling two things of the same name apart, once for three lists. */

const Harness = imports.harness;

const Naming = Harness.requireXlet("./lib/naming.js");

var cases = {};

cases["only the names that came out alike are marked"] = function () {
    let items = [
        { name: "Radeon RX 6600", identity: "03:00.0" },
        { name: "Radeon RX 6600", identity: "0a:00.0" },
        { name: "k10temp", identity: "00:18.3" },
    ];
    Harness.deepEqual(Naming.disambiguate(items), [
        "Radeon RX 6600 (03:00.0)",
        "Radeon RX 6600 (0a:00.0)",
        "k10temp",
    ], "a name nothing shares is left as it is");
};

cases["a shared name with nothing to tell it apart is left alone"] = function () {
    let items = [{ name: "fan1" }, { name: "fan1", identity: "" }];
    Harness.deepEqual(Naming.disambiguate(items), ["fan1", "fan1"],
                      "an absent identity is not appended as an empty bracket");
};

cases["an identity of zero still tells two things apart"] = function () {
    let items = [{ name: "Display", identity: 0 }, { name: "Display", identity: 1 }];
    Harness.deepEqual(Naming.disambiguate(items), ["Display (0)", "Display (1)"],
                      "the first display is numbered like the second");
};

cases["ambiguity is judged within a scope"] = function () {
    let items = [
        { name: "amdgpu", identity: "03:00.0", measure: "fan" },
        { name: "amdgpu", identity: "03:00.0", measure: "power" },
        { name: "amdgpu", identity: "0a:00.0", measure: "fan" },
    ];
    Harness.deepEqual(Naming.disambiguate(items, { scope: item => item.measure }), [
        "amdgpu (03:00.0)",
        "amdgpu",
        "amdgpu (0a:00.0)",
    ], "two readings of one card in different units are already apart");
};

cases["the name and the identity are the caller's to derive"] = function () {
    let items = [{ model: "U2723QE", socket: "DP-1" }, { model: "U2723QE", socket: "DP-2" }];
    Harness.deepEqual(Naming.disambiguate(items, {
        name: item => item.model,
        identity: item => item.socket,
    }), ["U2723QE (DP-1)", "U2723QE (DP-2)"], "neither has to be a field called name");
};

cases["an empty list names nothing"] = function () {
    Harness.deepEqual(Naming.disambiguate([]), [], "there is nothing to tell apart");
};
