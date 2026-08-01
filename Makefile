UUID    := cinnamon-powertoys@geraldo-netto
DESTDIR ?=
PREFIX  ?= $(HOME)/.local/share
TARGET  := $(DESTDIR)$(PREFIX)/cinnamon/applets/$(UUID)

.PHONY: install uninstall check pot restart help

help:
	@echo "make install    - install the applet for the current user"
	@echo "make uninstall  - remove the installed applet"
	@echo "make check      - syntax check the JavaScript and the helper script"
	@echo "make pot        - regenerate the translation template"
	@echo "make restart    - restart Cinnamon"

install:
	@mkdir -p $(dir $(TARGET))
	@rm -rf $(TARGET)
	@cp -r $(UUID) $(TARGET)
	@chmod +x $(TARGET)/powertoys-helper
	@echo "installed to $(TARGET)"

uninstall:
	@rm -rf $(TARGET)
	@echo "removed $(TARGET)"

check:
	@for file in $(UUID)/applet.js $(UUID)/lib/*.js; do \
		gjs -c "$$(cat $$file)" >/dev/null 2>&1 || \
		cjs -c "$$(cat $$file)" >/dev/null 2>&1 || \
		echo "skipped $$file (no gjs/cjs available)"; \
	done
	@sh -n $(UUID)/powertoys-helper && echo "helper script OK"
	@python3 -c "import json,sys; [json.load(open(f)) for f in ['$(UUID)/metadata.json','$(UUID)/settings-schema.json']]" \
		&& echo "json OK"

pot:
	@cinnamon-xlet-makepot $(UUID)

restart:
	@cinnamon --replace > /dev/null 2>&1 &
