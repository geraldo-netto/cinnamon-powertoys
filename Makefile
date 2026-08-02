UUID    := cinnamon-powertoys@geraldo-netto
DESTDIR ?=
PREFIX  ?= $(HOME)/.local/share
TARGET  := $(DESTDIR)$(PREFIX)/cinnamon/applets/$(UUID)

# The polkit action and the root owned helper it names. This path is written
# out in three places - here, in the action, and in applet.js - and `make
# check` fails if they stop agreeing, because a mismatch would quietly mean
# the action never applies and every change asks for a password again.
POLICY      := io.github.geraldo-netto.cinnamon-powertoys.policy
POLICY_DIR  := $(DESTDIR)/usr/share/polkit-1/actions
HELPER_PATH := /usr/local/lib/cinnamon-powertoys/powertoys-helper
HELPER_DEST := $(DESTDIR)$(HELPER_PATH)

.PHONY: install uninstall install-policy uninstall-policy check pot restart help

help:
	@echo "make install          - install the applet for the current user"
	@echo "make uninstall        - remove the installed applet"
	@echo "make install-policy   - (root) one password prompt per few minutes"
	@echo "                        instead of one per change; see README"
	@echo "make uninstall-policy - (root) remove it and go back to asking"
	@echo "make check            - syntax check the JavaScript, helper, JSON and policy"
	@echo "make pot              - regenerate the translation template"
	@echo "make restart          - restart Cinnamon"

install:
	@mkdir -p $(dir $(TARGET))
	@rm -rf $(TARGET)
	@cp -r $(UUID) $(TARGET)
	@chmod +x $(TARGET)/powertoys-helper
	@echo "installed to $(TARGET)"

uninstall:
	@rm -rf $(TARGET)
	@echo "removed $(TARGET)"

# Installs a root owned copy of the helper and the action that names it. The
# copy is the point: an authorisation that is kept for a few minutes must
# apply to a file the user cannot rewrite in the meantime.
install-policy:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make install-policy"; exit 1; }
	@install -d $(dir $(HELPER_DEST))
	@install -m 0755 $(UUID)/powertoys-helper $(HELPER_DEST)
	@install -d $(POLICY_DIR)
	@install -m 0644 polkit/$(POLICY) $(POLICY_DIR)/$(POLICY)
	@echo "installed $(HELPER_DEST)"
	@echo "installed $(POLICY_DIR)/$(POLICY)"
	@echo "re-run this after upgrading the applet, so the root owned copy of"
	@echo "the helper matches the one that ships with it"

uninstall-policy:
	@[ -n "$(DESTDIR)" ] || [ "$$(id -u)" = 0 ] || \
		{ echo "needs root: sudo make uninstall-policy"; exit 1; }
	@rm -f $(POLICY_DIR)/$(POLICY)
	@rm -f $(HELPER_DEST)
	@rmdir $(dir $(HELPER_DEST)) 2>/dev/null || true
	@echo "removed the action and the root owned helper"
	@echo "the applet keeps working and asks for a password on every change"

check:
	@command -v cjs >/dev/null 2>&1 || { echo "cjs not found, install the cjs package"; exit 1; }
	@cjs tools/parse-check.js $(UUID)/applet.js $(UUID)/lib/*.js
	@sh -n $(UUID)/powertoys-helper && echo "helper ok    $(UUID)/powertoys-helper"
	@python3 -c "import json; [json.load(open(f)) for f in ['$(UUID)/metadata.json','$(UUID)/settings-schema.json']]" \
		&& echo "json ok      $(UUID)/metadata.json $(UUID)/settings-schema.json"
	@python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('polkit/$(POLICY)')" \
		&& echo "policy ok    polkit/$(POLICY)"
	@grep -q '"$(HELPER_PATH)"' $(UUID)/applet.js \
		&& grep -q '>$(HELPER_PATH)<' polkit/$(POLICY) \
		&& echo "paths ok     $(HELPER_PATH)"

pot:
	@cinnamon-xlet-makepot $(UUID)

restart:
	@cinnamon --replace > /dev/null 2>&1 &
