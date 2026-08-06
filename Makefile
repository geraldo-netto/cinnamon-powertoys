UUID    := cinnamon-powertoys@geraldo-netto
DESTDIR ?=
PREFIX  ?= $(if $(XDG_DATA_HOME),$(XDG_DATA_HOME),$(HOME)/.local/share)
TARGET  := $(DESTDIR)$(PREFIX)/cinnamon/applets/$(UUID)

# The polkit action and the root owned helper it names. This path is written
# out in three places - here, in the action, and in applet.js - and `make
# check` fails if they stop agreeing, because a mismatch would quietly mean
# the action never applies and every change asks for a password again.
POT         := $(UUID)/po/$(UUID).pot
METADATA    := $(UUID)/metadata.json

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

.PHONY: install uninstall install-policy uninstall-policy install-rapl \
	uninstall-rapl check coverage mutants pot restart help

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
	@sh "$(POLICY_TOOL)" install "$(UUID)/powertoys-helper" "$(HELPER_DEST)" \
		"polkit/$(POLICY)" "$(POLICY_DIR)/$(POLICY)" "$(POLICY_LOCK)"
	@echo "installed $(HELPER_DEST)"
	@echo "installed $(POLICY_DIR)/$(POLICY)"
	@echo "re-run this after upgrading the applet, so the root owned copy of"
	@echo "the helper matches the one that ships with it"

uninstall-policy:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make uninstall-policy"; exit 1; }
	@sh "$(POLICY_TOOL)" uninstall "$(UUID)/powertoys-helper" "$(HELPER_DEST)" \
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
	@case "$(RAPL_GROUP)" in \
		""|*[!A-Za-z0-9_-]*) echo "invalid group name: $(RAPL_GROUP)"; exit 1;; \
		*) :;; \
	esac
	@[ -n "$(DESTDIR)" ] || getent group "$(RAPL_GROUP)" >/dev/null || \
		{ echo "no such group: $(RAPL_GROUP)"; exit 1; }
	@DESTDIR="$(DESTDIR)" sh "$(RAPL_TOOL)" install "udev/$(RAPL_RULE)" \
		"$(RAPL_DIR)/$(RAPL_RULE)" "$(RAPL_GROUP)" "$(RAPL_LOCK)"
	@echo "installed $(RAPL_DIR)/$(RAPL_RULE), reading given to group $(RAPL_GROUP)"
	@echo "open the applet menu to discover the counters now, or wait up to one minute"

uninstall-rapl:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make uninstall-rapl"; exit 1; }
	@DESTDIR="$(DESTDIR)" sh "$(RAPL_TOOL)" uninstall "udev/$(RAPL_RULE)" \
		"$(RAPL_DIR)/$(RAPL_RULE)" "$(RAPL_GROUP)" "$(RAPL_LOCK)"
	@echo "removed $(RAPL_DIR)/$(RAPL_RULE)"
	@echo "reapplied the remaining udev policy (root only when no other rule grants access)"

check:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@cjs tools/parse-check.js $(UUID)/applet.js $(UUID)/lib/*.js
	@cjs tests/run.js
	@sh -n $(UUID)/powertoys-helper install.sh tools/install-translations.sh \
		tools/uninstall.sh tools/deployment-lock.sh tools/cinnamon-xlets.sh \
		tools/transition-lock.sh \
		tools/rapl-access.sh tools/install-policy.sh \
		&& echo "shell ok     helper and install scripts"
	@python3 -c "import json; [json.load(open(f)) for f in ['$(UUID)/metadata.json','$(UUID)/settings-schema.json']]" \
		&& echo "json ok      $(UUID)/metadata.json $(UUID)/settings-schema.json"
	@python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('polkit/$(POLICY)')" \
		&& echo "policy ok    polkit/$(POLICY)"
	@grep -q '"$(HELPER_PATH)"' $(UUID)/applet.js \
		&& grep -q '>$(HELPER_PATH)<' polkit/$(POLICY) \
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
# through, an and that should have been an or, a guard dropped - run against
# the whole suite and then put back. It works on a copy in a temporary
# directory, so an interrupted run cannot leave a broken source behind.
#
# Minutes rather than seconds: one full suite run per mutant. Not part of
# check for that reason.
#
#   make mutants                                  - all of it
#   make mutants MUTANTS_ARGS="lib/ddc.js"        - one library
#   make mutants MUTANTS_ARGS="--sample 20"       - a seeded slice of each
mutants:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@cjs tools/mutate.js $(MUTANTS_ARGS) --min $(MUTANTS_MIN)

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
	@cinnamon-xlet-makepot $(UUID)
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
