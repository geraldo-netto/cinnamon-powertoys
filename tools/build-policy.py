#!/usr/bin/env python3
"""Add completed gettext translations to a polkit policy deterministically."""

import argparse
import gettext
import html
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET


MARKERS = {
    "description": "<?powertoys-description-translations?>",
    "message": "<?powertoys-message-translations?>",
}
LANGUAGE = re.compile(r"^[A-Za-z][A-Za-z0-9_.@-]*$")


def fallback_strings(template: Path) -> dict[str, str]:
    root = ET.parse(template).getroot()
    strings = {}
    for tag in MARKERS:
        elements = [
            element
            for element in root.findall(f".//{tag}")
            if "{http://www.w3.org/XML/1998/namespace}lang" not in element.attrib
        ]
        if len(elements) != 1 or not elements[0].text:
            raise ValueError(f"policy must contain one fallback {tag}")
        strings[tag] = elements[0].text
    return strings


def translations(po_dir: Path, strings: dict[str, str]) -> dict[str, list[tuple[str, str]]]:
    localized = {tag: [] for tag in MARKERS}
    for po in sorted(po_dir.glob("*.po"), key=lambda path: path.name):
        language = po.stem
        if not LANGUAGE.fullmatch(language):
            raise ValueError(f"invalid policy locale filename: {po.name}")
        with tempfile.TemporaryDirectory(prefix="powertoys-policy-") as temporary:
            mo = Path(temporary) / "messages.mo"
            subprocess.run(
                ["msgfmt", "--check", "--output-file", str(mo), str(po)],
                check=True,
            )
            with mo.open("rb") as stream:
                catalogue = gettext.GNUTranslations(stream)
        for tag, source in strings.items():
            translated = catalogue.gettext(source)
            if translated and translated != source:
                localized[tag].append((language, translated))
    return localized


def build(template: Path, po_dir: Path, output: Path) -> None:
    source = template.read_text(encoding="utf-8")
    strings = fallback_strings(template)
    localized = translations(po_dir, strings)
    for tag, marker in MARKERS.items():
        if source.count(marker) != 1:
            raise ValueError(f"policy must contain one {marker}")
        lines = [
            f'    <{tag} xml:lang="{html.escape(language, quote=True)}">'
            f"{html.escape(text, quote=False)}</{tag}>"
            for language, text in localized[tag]
        ]
        replacement = marker + (("\n" + "\n".join(lines)) if lines else "")
        source = source.replace(marker, replacement)
    ET.fromstring(source)
    output.write_text(source, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("po_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.template, args.po_dir, args.output)


if __name__ == "__main__":
    main()
