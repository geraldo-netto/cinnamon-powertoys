UUID    := cinnamon-powertoys@geraldo-netto
FILES_DIR := files
XLET_DIR  := $(FILES_DIR)/$(UUID)
DESTDIR ?=
PREFIX  ?= $(if $(XDG_DATA_HOME),$(XDG_DATA_HOME),$(HOME)/.local/share)
TARGET  := $(DESTDIR)$(PREFIX)/cinnamon/applets/$(UUID)

# The polkit action and the root owned helper it names. This path is written
# out in three places - here, in the action, and in applet.js - and `make
# check` fails if they stop agreeing, because a mismatch would quietly mean
# the action never applies and every change asks for a password again.
POT         := $(XLET_DIR)/po/$(UUID).pot
METADATA    := $(XLET_DIR)/metadata.json

# What the template says about itself, read out of metadata.json rather than
# written here, so the two cannot come to disagree about the applet's name,
# its version or where to report a problem with the strings. Recursive on
# purpose: only the pot target ever asks for them.
POT_NAME     = $(shell python3 -c "import json;print(json.load(open('$(METADATA)'))['name'])")
POT_VERSION  = $(shell python3 -c "import json;print(json.load(open('$(METADATA)'))['version'])")
POT_URL      = $(shell python3 -c "import json;print(json.load(open('$(METADATA)'))['url'])")

POLICY      := io.github.geraldo-netto.cinnamon-powertoys.policy
POLICY_DIR  := $(DESTDIR)/usr/share/polkit-1/actions
POLICY_TOOL := tools/install-policy.sh
POLICY_BUILDER := tools/build-policy.py
# What the action is allowed to grant, checked rather than reviewed: see the
# script, and the comment in the action itself for why the answer is what it is.
#
# Run twice on purpose. `make check` runs it over the template, which is the
# file under review; install-policy runs it over what the builder produced from
# that template plus the translations, which is the file that actually lands in
# /usr/share/polkit-1/actions. Only the second one is a grant of root on this
# machine, and it was the one nothing had ever checked - the builder only
# re-parsed its own output for well-formedness.
POLICY_CHECKER := tools/check-policy.py
POLICY_LOCK := $(if $(DESTDIR),$(DESTDIR),/run/cinnamon-powertoys-policy.lock)
HELPER_PATH := /usr/local/lib/cinnamon-powertoys/powertoys-helper
HELPER_DEST := $(DESTDIR)$(HELPER_PATH)
HELPER_DIR  := $(dir $(HELPER_DEST))

# The optional udev rule that makes the RAPL energy counters readable, and the
# group it hands them to. adm is the default because a desktop user is already
# in it, so the change takes effect without logging out. Read the rule and the
# README section it points at before installing it: it is a security trade.
RAPL_RULE   := 99-cinnamon-powertoys-rapl.rules
RAPL_DIR    := $(DESTDIR)/etc/udev/rules.d
RAPL_GROUP  ?= adm
RAPL_TOOL   := tools/rapl-access.sh
RAPL_LOCK   := $(if $(DESTDIR),$(DESTDIR),/run/cinnamon-powertoys-rapl.lock)

# Where a coverage run puts the copies it measures and the lcov it produces,
# and the figure every function has to reach. Per function rather than per
# file: a file of small well covered functions carries an untouched one without
# its total moving much, which is the one thing a percentage should not hide.
COVERAGE_DIR := .coverage
COVERAGE_MIN ?= 80

# How many of the deliberate mistakes the suite has to catch, and how many to
# try. MUTANTS_ARGS takes file names to work on one library at a time, and
# --sample N for a quick answer on a big one.
MUTANTS_MIN ?= 80
MUTANTS_ARGS ?=
MUTANTS_JOBS ?= 4

# Where `make dist` puts the release archive and its checksum, and the tool
# that writes them. Ignored by git: it is output, not source.
DIST_DIR ?= dist
PACKAGE_TOOL := tools/build-package.py

# Every script this repository ships or runs, and every Python tool beside
# them, named once. The list used to be written out by hand in the one place
# that parsed it, so a script added under tools/ was checked by nothing until
# somebody noticed.
#
# Found rather than matched. `$(wildcard tools/*.sh)` cannot forget a script
# and cannot see one a directory further down either, which is the same hole
# with a longer fuse: the payload lists below were wildcards over lib/ and ui/
# exactly, and a file at lib/anything/x.js was parsed by nothing, resolved by
# nothing, read for strings by nothing and listed by no coverage report - and
# was still packaged by `make dist`, which walks the payload with rglob and so
# ships whatever is in it. Sorted, so the lists are a function of the tree and
# not of the order a directory happens to be read in.
SHELL_SOURCES := $(XLET_DIR)/powertoys-helper install.sh \
	$(shell find tools -name '*.sh' | sort)
PYTHON_SOURCES := $(shell find tools -name '*.py' | sort)

# The JavaScript the gates read, split by what may be assumed about it. The
# runtime sources are what Cinnamon evaluates; the rest is developer tooling
# and the cases, which run under cjs directly. Both are resolved, because a
# name that does not exist is the same mistake wherever it is written.
#
# applet.js is named first and then filtered out of the walk, because it is
# the file the whole applet hangs off and a reader of a failure list should
# meet it before the libraries it requires.
JS_SOURCES := $(XLET_DIR)/applet.js \
	$(filter-out $(XLET_DIR)/applet.js,$(shell find $(XLET_DIR) -name '*.js' | sort))
JS_TOOL_SOURCES := $(shell find tools tests -name '*.js' | sort)

# What the lint gates are allowed to let past, stated here so the reason is
# next to the exception rather than repeated on forty lines.
#
# SC2317 calls a command unreachable when it cannot see who runs it. Every one
# of these scripts installs an EXIT/HUP/INT/TERM trap that rolls a half-done
# transaction back, and the body of a trap handler is exactly the code
# ShellCheck cannot find a caller for. Suppressing it in place would mean a
# directive on each of them.
#
# The Python line length is the one this tree already writes to; pycodestyle's
# own default of 79 would report the existing files rather than regressions.
SHELLCHECK_EXCLUDE := SC2317
PYLINT_MAX_LINE ?= 100

.PHONY: install uninstall install-policy uninstall-policy install-rapl \
	uninstall-rapl check coverage mutants dist pot restart help

help:
	@echo "make install          - install the applet for the current user"
	@echo "make uninstall        - remove the installed applet"
	@echo "make install-policy   - (root) enable safe privileged changes and keep"
	@echo "                        authentication for a few minutes; see README"
	@echo "make uninstall-policy - (root) disable privileged changes"
	@echo "make install-rapl     - (root) let the applet read CPU package power,"
	@echo "                        at the cost described in README; read it first"
	@echo "make uninstall-rapl   - (root) make those counters root only again"
	@echo "make check            - run the tests and check the JavaScript, helper,"
	@echo "                        JSON and policy"
	@echo "make coverage         - run the tests again under the interpreter's own"
	@echo "                        coverage and report it per function"
	@echo "make dist             - build the release archive and its checksum"
	@echo "make pot              - regenerate the translation template"
	@echo "make restart          - restart Cinnamon"

# One install path, not two. install.sh is the one that also reloads the
# running applet, so a change is visible without restarting Cinnamon; having
# this target do its own copy is how the two came to differ in the first place.
install:
	@PREFIX="$(PREFIX)" DESTDIR="$(DESTDIR)" ./install.sh

uninstall:
	@PREFIX="$(PREFIX)" DESTDIR="$(DESTDIR)" sh tools/uninstall.sh

# Installs a root owned copy of the helper and the action that names it. The
# copy is the point: an authorisation that is kept for a few minutes must
# apply to a file the user cannot rewrite in the meantime.
install-policy:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make install-policy"; exit 1; }
	@[ -z "$(DESTDIR)" ] || install -d "$(DESTDIR)"
	@built_policy=$$(mktemp); \
		trap 'rm -f -- "$$built_policy"' EXIT HUP INT TERM; \
		python3 "$(POLICY_BUILDER)" "polkit/$(POLICY)" "$(XLET_DIR)/po" "$$built_policy"; \
		python3 "$(POLICY_CHECKER)" "$$built_policy" "$(HELPER_PATH)"; \
		sh "$(POLICY_TOOL)" install "$(XLET_DIR)/powertoys-helper" "$(HELPER_DEST)" \
			"$$built_policy" "$(POLICY_DIR)/$(POLICY)" "$(POLICY_LOCK)"
	@echo "installed $(HELPER_DEST)"
	@echo "installed $(POLICY_DIR)/$(POLICY)"
	@echo "re-run this after upgrading the applet, so the root owned copy of"
	@echo "the helper matches the one that ships with it"

uninstall-policy:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make uninstall-policy"; exit 1; }
	@[ -z "$(DESTDIR)" ] || install -d "$(DESTDIR)"
	@sh "$(POLICY_TOOL)" uninstall "$(XLET_DIR)/powertoys-helper" "$(HELPER_DEST)" \
		"polkit/$(POLICY)" "$(POLICY_DIR)/$(POLICY)" "$(POLICY_LOCK)"
	@echo "removed the action and the root owned helper"
	@echo "monitoring still works; privileged changes are disabled"

# Reading, not writing, and still root's to give away: see the rule itself and
# the README section on it. The counters that already exist are handed over
# here as well as in the rule, because a rule only fires on an event and these
# nodes appeared when the machine booted.
install-rapl:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make install-rapl"; exit 1; }
	@[ -z "$(DESTDIR)" ] || install -d "$(DESTDIR)"
	@case "$(RAPL_GROUP)" in \
		""|-*|*[!A-Za-z0-9_-]*) echo "invalid group name: $(RAPL_GROUP)"; exit 1;; \
		*) :;; \
	esac
	@DESTDIR="$(DESTDIR)" sh "$(RAPL_TOOL)" install "udev/$(RAPL_RULE)" \
		"$(RAPL_DIR)/$(RAPL_RULE)" "$(RAPL_GROUP)" "$(RAPL_LOCK)"
	@echo "installed $(RAPL_DIR)/$(RAPL_RULE), reading given to group $(RAPL_GROUP)"
	@echo "open the applet menu to discover the counters now, or wait up to one minute"

uninstall-rapl:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make uninstall-rapl"; exit 1; }
	@[ -z "$(DESTDIR)" ] || install -d "$(DESTDIR)"
	@DESTDIR="$(DESTDIR)" sh "$(RAPL_TOOL)" uninstall "udev/$(RAPL_RULE)" \
		"$(RAPL_DIR)/$(RAPL_RULE)" "$(RAPL_GROUP)" "$(RAPL_LOCK)"
	@echo "removed $(RAPL_DIR)/$(RAPL_RULE)"
	@echo "reapplied the remaining udev policy (root only when no other rule grants access)"

# Parse, resolve, run, and read. The parse check says the engine will accept
# the file; the scope check says every name written in it exists, which is the
# mistake a parse cannot see and is the one a machine without Cinnamon can
# still find in applet.js - the suite's shell load evaluates it for real, but
# only where there is a Cinnamon to evaluate it against. tools/shell-syntax.sh
# says each script is syntactically a script - one at a time, because `sh -n`
# given several files parses the first and takes the rest as its arguments;
# ShellCheck says whether it means what it looks like, which is the class of
# mistake a shell only reports at the moment it goes wrong on somebody's
# machine. flake8 does the same for the Python tools beside them.
#
# The strings check is the half of the translation question that needs no
# extractor: every literal the sources ask to have translated is one the
# template offers. The workflow's `make pot` diff is the whole of it and stays;
# this is the part a contributor gets before pushing rather than after.
#
# A missing tool fails rather than skips. A gate that prints "not available,
# skipping" reports success for as long as nobody installs it, which is
# indistinguishable from having no gate at all.
check:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@sh tools/check-layout.sh "$(UUID)" "$(FILES_DIR)"
	@cjs tools/parse-check.js $(JS_SOURCES)
	@cjs tools/scope-check.js $(JS_SOURCES) $(JS_TOOL_SOURCES)
	@cjs tests/run.js
	@sh tools/shell-syntax.sh $(SHELL_SOURCES)
	@command -v shellcheck >/dev/null 2>&1 || \
		{ echo "shellcheck not found, install the shellcheck package"; exit 1; }
	@shellcheck --shell=sh --severity=style --external-sources \
		--exclude=$(SHELLCHECK_EXCLUDE) $(SHELL_SOURCES) \
		&& echo "lint ok      shell, semantic"
	@command -v flake8 >/dev/null 2>&1 || \
		{ echo "flake8 not found, install the python3-flake8 package"; exit 1; }
	@flake8 --max-line-length=$(PYLINT_MAX_LINE) $(PYTHON_SOURCES) \
		&& echo "lint ok      python developer tooling"
	@python3 -c "import json; [json.load(open(f)) for f in ['$(XLET_DIR)/metadata.json','$(XLET_DIR)/settings-schema.json','info.json']]" \
		&& echo "json ok      runtime metadata, settings and Spices info"
	@cjs tools/strings-check.js $(POT) $(JS_SOURCES)
	@python3 $(POLICY_CHECKER) polkit/$(POLICY) $(HELPER_PATH)
	@grep -q '"$(HELPER_PATH)"' $(XLET_DIR)/applet.js \
		&& grep -q '>$(HELPER_PATH)<' polkit/$(POLICY) \
		&& grep -q '=$(HELPER_PATH)$$' tools/uninstall.sh \
		&& echo "paths ok     $(HELPER_PATH)"

# Coverage, per function, from the interpreter rather than from a guess.
#
# cjs measures what it compiles from a file, and a library here is compiled out
# of a string by new Function - which is how Cinnamon loads an xlet, and which
# leaves nothing to attribute a line to. So the run writes each library out
# again, one file per library, and loads those instead; the body is the same
# text the ordinary run evaluates, wrapped so that line one stays line one.
#
# Separate from check because it runs the whole suite a second time and needs
# the interpreter's coverage machinery, which the parse check and the tests do
# not. The gate is COVERAGE_MIN, per function.
coverage:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@rm -rf $(COVERAGE_DIR)
	@mkdir -p $(COVERAGE_DIR)/modules
	@POWERTOYS_COVERAGE_DIR=$(abspath $(COVERAGE_DIR))/modules \
		cjs --coverage-prefix=$(abspath $(COVERAGE_DIR))/modules \
		    --coverage-output=$(abspath $(COVERAGE_DIR)) \
		    tests/run.js > $(COVERAGE_DIR)/run.log 2>&1 || \
		{ cat $(COVERAGE_DIR)/run.log; exit 1; }
	@report_status=0; \
		cjs tools/coverage-report.js $(COVERAGE_DIR) --min $(COVERAGE_MIN) \
		    > $(COVERAGE_DIR)/report.log 2>&1 || report_status=$$?; \
		cat $(COVERAGE_DIR)/report.log; \
		exit $$report_status

# Break the code on purpose and see whether the suite notices.
#
# Coverage says a line ran; this says that running it proved something. Each
# mutant is one small plausible mistake - a comparison that lets its boundary
# through, an and that should have been an or, a guard dropped. Related cases
# run first and stop at the first kill; only a survivor traverses every case.
# Isolated temporary copies keep workers and the working tree independent.
#
# Minutes rather than seconds: one isolated CJS process per mutant. Not part
# of check for that reason.
#
#   make mutants                                  - all of it
#   make mutants MUTANTS_ARGS="lib/ddc.js"        - one library
#   make mutants MUTANTS_ARGS="--sample 20"       - a seeded slice of each
#   make mutants MUTANTS_ARGS="--full-suite"       - legacy ordering oracle
mutants:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@cjs tools/mutate.js --jobs $(MUTANTS_JOBS) $(MUTANTS_ARGS) --min $(MUTANTS_MIN)

# The archive that goes to Spices or to a release, and the checksum that makes
# it worth publishing.
#
# Byte for byte the same for the same commit: fixed timestamps, fixed modes,
# sorted entries. A checksum beside an archive whose bytes depend on when it
# was built tells the reader which machine built it and nothing about what is
# inside, which is the opposite of the point.
#
# What goes in is the Spices submission layout - the payload directory and the
# three wrapper assets - checked first against the same layout, policy and
# helper-path rules `make check` applies, so a release cannot be cut from a
# tree those would reject. Deliberately not part of check: it writes output.
dist:
	@rm -rf $(DIST_DIR)
	@python3 $(PACKAGE_TOOL) --uuid "$(UUID)" --policy "polkit/$(POLICY)" \
		--helper "$(HELPER_PATH)" --output "$(DIST_DIR)"

# The template, as a function of the sources and of nothing else.
#
# cinnamon-xlet-makepot stamps POT-Creation-Date from the clock, so two runs
# over identical sources differed by that one line: a contributor who ran this
# got a dirty tree for no reason, and the workflow step that checks the
# template is current could never pass, whatever the strings said. The field
# records when the extraction ran rather than anything about the strings, and
# nothing downstream needs it - msginit writes its own, msgmerge works from
# PO-Revision-Date - so it is taken back out.
#
# The header is stamped for the same reason the stamp is stripped: it is the
# first thing a translator sees. What the extractor writes is
# "SOME DESCRIPTIVE TITLE", "PACKAGE VERSION" and "FIRST AUTHOR
# <EMAIL@ADDRESS>", so the file named neither the applet nor anywhere to send
# the result. The three fields that identify the project are filled in from
# metadata.json; the ones that identify the translator are left alone, because
# msginit fills those in with whoever is doing the work.
#
# Nothing here reads a clock, so the template is still a function of the
# sources and the workflow's check can still be a plain diff.
pot:
	@cinnamon-xlet-makepot $(XLET_DIR)
	@xgettext --its=polkit/policy.its --join-existing --from-code=UTF-8 \
		-o $(POT) polkit/$(POLICY)
	@sed -i '/^"POT-Creation-Date:/d' $(POT)
	@sed -i \
		-e 's|^# SOME DESCRIPTIVE TITLE\.$$|# Translation template for $(POT_NAME), a Cinnamon applet.|' \
		-e "s|^# Copyright (C) YEAR THE PACKAGE'S COPYRIGHT HOLDER$$|# Copyright (C) the $(POT_NAME) authors.|" \
		-e 's|^# This file is distributed under the same license as the PACKAGE package\.$$|# Distributed under the MIT license, with the rest of $(UUID).|' \
		-e 's|^# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR\.$$|# To start a language, see the Translating section of README.md.|' \
		-e 's|^"Project-Id-Version: PACKAGE VERSION|"Project-Id-Version: $(POT_NAME) $(POT_VERSION)|' \
		-e 's|^"Report-Msgid-Bugs-To: |"Report-Msgid-Bugs-To: $(POT_URL)/issues|' \
		$(POT)
	@# A placeholder left standing means the extractor's header has moved and
	@# one of the expressions above quietly matched nothing. Say so, rather
	@# than shipping the placeholder again.
	@! grep -qE "SOME DESCRIPTIVE TITLE|PACKAGE VERSION|COPYRIGHT HOLDER|FIRST AUTHOR" $(POT) || \
		{ echo "the extractor's header has changed; update the pot target"; exit 1; }
	@echo "pot ok       $(POT), reproducible, stamped from $(METADATA)"

restart:
	@cinnamon --replace > /dev/null 2>&1 &
