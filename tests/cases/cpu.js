/*
 * The processor's own settings, read out of cpufreq.
 *
 * There were no cases here. lib/cpu.js was reached only by the sensor cases
 * that happen to load it, so what it says about a machine - which governors
 * there are, whether there is a turbo switch and which way round it reads,
 * what the frequency is - had never been checked against a machine at all.
 *
 * Two fixtures do the work. `machine` is an AMD laptop: cpufreq/boost, two
 * policies, amd_pstate in its active mode. `inverted-boost` is the Intel
 * arrangement, where the switch is called no_turbo and means the opposite of
 * what it is asked for - which is the one place in this file where reading it
 * the wrong way round would leave the menu showing turbo as off on a machine
 * where it is on, and switching it would then do the opposite of what it said.
 */

const GLib = imports.gi.GLib;
const Harness = imports.harness;
const Fuzz = imports.fuzz;

const Cpu = Harness.requireXlet("./lib/cpu.js");
const Hardware = Harness.requireXlet("./lib/hardware.js");
const IO = Harness.requireXlet("./lib/io.js");

/* A control over a captured tree, with the commands it was asked to run. */
function control(fixture) {
    Hardware.forget();
    IO.setRoot(Harness.fixture(fixture));
    let commands = [];
    let cpu = new Cpu.CpuControl((args, onDone) => {
        commands.push(args.join(" "));
        if (onDone)
            onDone({ applied: true });
    });
    cpu.commands = commands;
    return cpu;
}

function release() {
    IO.setRoot("");
    Hardware.forget();
}

/* A tree of this case's own, for the arrangements no fixture has. */
function scratch(files, body) {
    let directory = GLib.dir_make_tmp("powertoys-cpu-XXXXXX");
    try {
        for (let path in files) {
            let full = directory + path;
            GLib.mkdir_with_parents(GLib.path_get_dirname(full), 0o755);
            GLib.file_set_contents(full, files[path]);
        }
        Hardware.forget();
        IO.setRoot(directory);
        return body();
    } finally {
        release();
        GLib.spawn_sync(null, ["rm", "-rf", directory], null, GLib.SpawnFlags.SEARCH_PATH, null);
    }
}

var cases = {};

cases["a machine with cpufreq says what it can be set to"] = function () {
    try {
        let cpu = control("machine");
        Harness.equal(cpu.available, true, "there are policies, so there is something to set");
        Harness.equal(cpu.policies.length, 2, "one per core group");
        Harness.equal(cpu.driver, "amd-pstate-epp", "the scaling driver");
        Harness.deepEqual(cpu.governors, ["performance", "powersave"], "what it will take");
        Harness.deepEqual(cpu.energyPreferences, ["default", "performance", "power"],
                          "and the energy preferences beside them");
        Harness.equal(cpu.amdPstateStatus, "active", "the pstate mode, which changes what the rest means");
        Harness.equal(cpu.governor, "powersave", "where it is now");
        Harness.equal(cpu.energyPreference, "power", "and what it is aiming at");
    } finally {
        release();
    }
};

cases["a machine with no cpufreq at all offers nothing"] = function () {
    /* A virtual machine, a container, an ARM board with no scaling driver.
     * Every list is empty rather than absent, so the menu has nothing to
     * draw and no reason to ask first. */
    scratch({}, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.available, false, "nothing to set");
        Harness.equal(cpu.reference, null, "no policy to read from");
        Harness.equal(cpu.driver, null, "no driver");
        Harness.deepEqual(cpu.governors, [], "no governors");
        Harness.deepEqual(cpu.energyPreferences, [], "no preferences");
        Harness.equal(cpu.governor, null, "and nothing to report as current");
        Harness.equal(cpu.energyPreference, null, "either of them");
        Harness.equal(cpu.boostSupported, false, "no turbo switch");
        Harness.equal(cpu.boostEnabled, null, "so nothing to say about turbo");
        Harness.equal(cpu.averageFrequency(), null, "and no frequency to average");
        Harness.equal(cpu.maxFrequency(), null, "nor a ceiling");
    });
};

cases["heterogeneous policies expose only shared choices and agreed values"] = function () {
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_available_governors":
            "performance powersave schedutil\n",
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_governor": "powersave\n",
        "/sys/devices/system/cpu/cpufreq/policy0/energy_performance_available_preferences":
            "default performance power\n",
        "/sys/devices/system/cpu/cpufreq/policy0/energy_performance_preference": "power\n",
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_available_governors":
            "performance powersave\n",
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_governor": "performance\n",
        "/sys/devices/system/cpu/cpufreq/policy1/energy_performance_available_preferences":
            "default balance_performance\n",
        "/sys/devices/system/cpu/cpufreq/policy1/energy_performance_preference": "default\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.deepEqual(cpu.governors, ["performance", "powersave"],
                          "only governors every policy accepts");
        Harness.equal(cpu.governor, null, "different current governors do not become one claim");
        Harness.deepEqual(cpu.energyPreferences, ["default"],
                          "only preferences every EPP policy accepts");
        Harness.equal(cpu.energyPreference, null,
                      "different current preferences do not become one claim");
    });
};

cases["a policy that cannot describe its governors prevents unsafe choices"] = function () {
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_available_governors":
            "performance powersave\n",
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_governor": "powersave\n",
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_governor": "powersave\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.deepEqual(cpu.governors, [], "no choice is guessed from the first policy");
        Harness.equal(cpu.governor, "powersave", "agreement is still reported independently");
    });
};

cases["the frequency is the average across every policy"] = function () {
    /* One number stands for a processor whose cores are all at different
     * speeds, and it is read from all of them rather than from the first. */
    try {
        let cpu = control("machine");
        Harness.near(cpu.averageFrequency(), 3500, 0.001,
                     "the two policies averaged, in megahertz");
        Harness.near(cpu.maxFrequency(), 5462.711, 0.001, "and the ceiling the silicon has");
    } finally {
        release();
    }

    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq": "1000000\n",
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_cur_freq": "3000000\n",
        "/sys/devices/system/cpu/cpufreq/policy2/scaling_cur_freq": "2000000\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.near(cpu.averageFrequency(), 2000, 0.001, "the average of the three");
    });
};

cases["the ceiling is the highest valid policy maximum"] = function () {
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/cpuinfo_max_freq": "2800000\n",
        "/sys/devices/system/cpu/cpufreq/policy1/cpuinfo_max_freq": "5100000\n",
        "/sys/devices/system/cpu/cpufreq/policy2/cpuinfo_max_freq": "not-a-number\n",
        "/sys/devices/system/cpu/cpufreq/policy3/cpuinfo_max_freq": "0\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.near(cpu.maxFrequency(), 5100, 0.001,
                     "a heterogeneous processor's fastest policy");
    });
};

cases["a policy that will not answer is left out of the average"] = function () {
    /* Rather than counted as nought, which would pull the figure down and
     * report a processor that is idling when one core group is simply not
     * answering. */
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq": "4000000\n",
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_driver": "acpi-cpufreq\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.policies.length, 2, "two policies");
        Harness.near(cpu.averageFrequency(), 4000, 0.001, "and one figure between them");
    });
};

cases["the driver's own averaged frequency is preferred where it has one"] = function () {
    /* amd-pstate publishes cpuinfo_avg_freq, which is the firmware's own
     * average over the interval rather than a sample of this instant. */
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/cpuinfo_avg_freq": "2500000\n",
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq": "4000000\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.near(cpu.averageFrequency(), 2500, 0.001, "the driver's figure, not the sample");
    });
};

cases["the turbo switch reads the way the machine writes it"] = function () {
    /*
     * Two arrangements that mean opposite things. cpufreq/boost is 1 for on;
     * intel_pstate/no_turbo is 0 for on, and reading it as though it were the
     * first would show turbo off on a machine where it is on - and then
     * switching it would do the opposite of what the switch said.
     */
    try {
        let cpu = control("machine");
        Harness.equal(cpu.boostSupported, true, "there is a switch");
        Harness.equal(cpu.boostInverted, false, "and it says what it means");
        Harness.equal(cpu.boostEnabled, true, "boost is on");
    } finally {
        release();
    }

    try {
        let cpu = control("inverted-boost");
        Harness.equal(cpu.boostSupported, true, "there is a switch here too");
        Harness.equal(cpu.boostInverted, true, "and it is the other kind");
        Harness.equal(cpu.boostEnabled, true, "no_turbo of 0 is turbo on");
    } finally {
        release();
    }

    scratch({ "/sys/devices/system/cpu/intel_pstate/no_turbo": "1\n" }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.boostEnabled, false, "and no_turbo of 1 is turbo off");
    });

    scratch({ "/sys/devices/system/cpu/cpufreq/boost": "0\n" }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.boostEnabled, false, "as boost of 0 is off the plain way round");
    });
};

cases["a turbo switch that will not read is not a turbo switch that is off"] = function () {
    /* The node exists and answers nothing, which is what a driver being
     * unloaded underneath the applet looks like. Off is a claim; null is not. */
    scratch({ "/sys/devices/system/cpu/cpufreq/boost": "\n" }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.boostSupported, true, "the node is there");
        Harness.equal(cpu.boostEnabled, null, "and it said nothing");
    });
};

cases["cpufreq/boost is preferred where a machine has both"] = function () {
    scratch({
        "/sys/devices/system/cpu/cpufreq/boost": "1\n",
        "/sys/devices/system/cpu/intel_pstate/no_turbo": "1\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.boostInverted, false, "the plain switch wins");
        Harness.equal(cpu.boostEnabled, true, "and is read the plain way round");
    });
};

cases["every write goes out in the helper's own words"] = function () {
    /*
     * These four strings are the whole vocabulary the privileged helper
     * accepts, and this is the only place in the applet that knows them. A
     * word changed on either side is a change that silently does nothing:
     * the helper answers "usage" and the applet reports that the change
     * could not be applied, without saying which word it did not know.
     */
    try {
        let cpu = control("machine");
        cpu.setGovernor("performance");
        cpu.setEnergyPreference("power");
        cpu.setBoost(true);
        cpu.setBoost(false);
        Harness.deepEqual(cpu.commands,
                          ["governor performance", "epp power", "boost 1", "boost 0"],
                          "the helper's vocabulary, and the value beside it");

        let helper = Harness.readFile(Harness.xletDir() + "/powertoys-helper");
        for (let word of ["governor", "epp", "boost"]) {
            Harness.ok(helper.indexOf("    " + word + ")") >= 0 ||
                       helper.indexOf(word + ")   ") >= 0,
                       "the helper still answers to " + word);
        }
    } finally {
        release();
    }
};

cases["what a write is given is what the helper is given"] = function () {
    /* The value is passed through as text without being judged here: the
     * helper checks it against what the kernel itself advertises, which is
     * the only list that cannot be out of date. */
    try {
        let cpu = control("machine");
        Fuzz.forAll({ what: "setGovernor", runs: 200 },
                    random => Fuzz.text(random, 3),
                    name => {
                        cpu.commands.length = 0;
                        Fuzz.answers(() => cpu.setGovernor(name));
                        Harness.equal(cpu.commands.length, 1, "one command");
                        if (cpu.commands[0] !== "governor " + name)
                            throw new Error("sent " + JSON.stringify(cpu.commands[0]));
                    });
    } finally {
        release();
    }
};

cases["a reading works out only what somebody asks for"] = function () {
    /*
     * The four lazy fields each cost a file read - the frequency one per
     * policy, which is thirty-two of them on a sixteen core machine - and
     * each can be displayed nowhere: the governor only in the menu and the
     * tooltip, the frequency only where the panel was asked for it. With the
     * menu shut and the pointer elsewhere, which is nearly always, a poll
     * should read no cpufreq node at all.
     */
    try {
        let cpu = control("machine");
        let reads = [];
        let real = IO.readString;
        IO.readString = function (path) {
            reads.push(path);
            return real(path);
        };
        try {
            let snapshot = cpu.snapshot();
            Harness.deepEqual(reads, [], "taking the reading read nothing");
            Harness.equal(snapshot.available, true, "and it still knows what it knew");

            Harness.equal(snapshot.governor, "powersave", "asking is what reads it");
            Harness.ok(reads.length > 0, "and now something was read");
        } finally {
            IO.readString = real;
        }
    } finally {
        release();
    }
};

cases["a reading is the same answer twice, without reading twice"] = function () {
    try {
        let cpu = control("machine");
        let snapshot = cpu.snapshot();
        Harness.equal(snapshot.governor, "powersave", "once");
        Harness.equal(snapshot.governor, "powersave", "and again");

        /* The second answer comes from the first, so a node that changes
         * under a reading does not change the reading. */
        let reads = 0;
        let real = IO.readString;
        IO.readString = function (path) {
            reads++;
            return real(path);
        };
        try {
            snapshot.governor;
            Harness.equal(reads, 0, "the answer was kept");
        } finally {
            IO.readString = real;
        }
    } finally {
        release();
    }
};

cases["looking again picks up hardware that has changed underneath"] = function () {
    /* A scaling driver swapped, a policy appearing: refresh is what the menu
     * calls when it opens, and it has to replace everything that a driver
     * swap can change. */
    let directory = GLib.dir_make_tmp("powertoys-cpu-XXXXXX");
    try {
        let policy = directory + "/sys/devices/system/cpu/cpufreq/policy0";
        GLib.mkdir_with_parents(policy, 0o755);
        GLib.file_set_contents(policy + "/scaling_driver", "acpi-cpufreq\n");
        GLib.file_set_contents(policy + "/scaling_available_governors", "ondemand powersave\n");
        Hardware.forget();
        IO.setRoot(directory);

        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.driver, "acpi-cpufreq", "what it found first");
        Harness.deepEqual(cpu.governors, ["ondemand", "powersave"], "and the list with it");

        GLib.file_set_contents(policy + "/scaling_driver", "amd-pstate-epp\n");
        GLib.file_set_contents(policy + "/scaling_available_governors", "performance powersave\n");
        Harness.equal(cpu.driver, "acpi-cpufreq", "still what it found first");

        cpu.refresh();
        Harness.equal(cpu.driver, "amd-pstate-epp", "and now what is there");
        Harness.deepEqual(cpu.governors, ["performance", "powersave"], "list and all");
    } finally {
        release();
        GLib.spawn_sync(null, ["rm", "-rf", directory], null, GLib.SpawnFlags.SEARCH_PATH, null);
    }
};

cases["an asynchronous control adopts one complete CPU snapshot"] = function () {
    try {
        Hardware.forget();
        IO.setRoot(Harness.fixture("machine"));
        let before = null;
        let cpu = Harness.settle(function (done) {
            let created = new Cpu.CpuControl(() => {}, {
                asynchronous: true,
                onChanged: () => done(created),
            });
            before = created.snapshot();
        }, "asynchronous CPU discovery");

        Harness.equal(before.available, false, "construction exposes no partial policy list");
        let after = cpu.snapshot();
        Harness.equal(after.available, true, "the complete machine is adopted together");
        Harness.deepEqual(after.governors, ["performance", "powersave"], "with its choices");
        Harness.equal(after.governor, "powersave", "current values were loaded off-thread too");
        Harness.near(after.averageFrequency, 3500, 0.001, "including every policy frequency");
        cpu.destroy();
    } finally {
        release();
    }
};

cases["an asynchronous CPU refresh performs no synchronous file access"] = function () {
    try {
        Hardware.forget();
        IO.setRoot(Harness.fixture("machine"));
        let cpu = Harness.settle(function (done) {
            let created = new Cpu.CpuControl(() => {}, {
                asynchronous: true,
                onChanged: () => done(created),
            });
        }, "initial asynchronous CPU discovery");

        let listDir = IO.listDir;
        let readString = IO.readString;
        let exists = IO.exists;
        let model = Hardware.cpuModelName;
        IO.listDir = () => { throw new Error("synchronous directory listing"); };
        IO.readString = () => { throw new Error("synchronous value read"); };
        IO.exists = () => { throw new Error("synchronous existence query"); };
        Hardware.cpuModelName = () => { throw new Error("synchronous CPU name read"); };
        try {
            let after = Harness.settle(done => cpu.refresh(() => done(cpu.snapshot())),
                                       "non-blocking CPU refresh");
            Harness.equal(after.governor, "powersave", "the replacement snapshot is complete");
            Harness.near(after.averageFrequency, 3500, 0.001, "and contains dynamic values");
        } finally {
            IO.listDir = listDir;
            IO.readString = readString;
            IO.exists = exists;
            Hardware.cpuModelName = model;
            cpu.destroy();
        }
    } finally {
        release();
    }
};

cases["overlapping CPU refreshes settle from a newer discovery"] = function () {
    try {
        let cpu = control("machine");
        let discoveries = [];
        let answers = [];
        let changed = 0;
        cpu._asynchronous = true;
        cpu._discoverAsync = done => discoveries.push(done);
        cpu._adopt = governor => { cpu._governor = governor; };
        cpu._onChanged = () => changed++;

        cpu.refresh(() => answers.push(cpu.snapshot().governor));
        cpu.refresh(() => answers.push(cpu.snapshot().governor));
        Harness.equal(discoveries.length, 1, "one discovery starts immediately");

        discoveries.shift()("old");
        Harness.equal(discoveries.length, 1, "the overlapping request starts one replay");
        Harness.deepEqual(answers, [], "no caller settles from the superseded snapshot");
        Harness.equal(changed, 0, "the superseded snapshot is not announced");

        discoveries.shift()("new");
        Harness.deepEqual(answers, ["new", "new"], "both callers see the replayed state");
        Harness.equal(changed, 1, "only the current snapshot is announced");
        cpu.destroy();
    } finally {
        release();
    }
};

cases["one policy is a machine, not half of one"] = function () {
    /*
     * Plenty of machines expose a single cpufreq policy for every core - an
     * intel_pstate laptop, most ARM boards - and a control that only counted
     * itself available from two would leave the whole Processor group off the
     * menu there, with nothing to say why.
     */
    scratch({
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_driver": "intel_pstate\n",
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_governor": "powersave\n",
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_available_governors": "performance powersave\n",
    }, function () {
        let cpu = new Cpu.CpuControl(() => {});
        Harness.equal(cpu.policies.length, 1, "one policy");
        Harness.equal(cpu.available, true, "and that is a machine this applet can set");
        Harness.equal(cpu.governor, "powersave", "with a governor to read");
    });
};

cases["a lazy field is the object's, and the object is handed back"] = function () {
    /*
     * The helper that makes the four expensive fields cost nothing until
     * somebody reads them. It answers with the object it was given so that a
     * reading can be built up in one expression, and it is worth pinning: a
     * helper that quietly answered with something else would leave snapshot()
     * building a reading out of nothing at all.
     */
    let reading = { available: true };
    let produced = 0;
    let same = Cpu._lazy(reading, "governor", () => {
        produced++;
        return "powersave";
    });
    Harness.equal(same, reading, "the very object that went in");
    Harness.equal(produced, 0, "and nothing has been worked out yet");
    Harness.equal(same.governor, "powersave", "until it is asked for");
    Harness.equal(same.governor, "powersave", "and then it is the same answer");
    Harness.equal(produced, 1, "worked out once");
};
