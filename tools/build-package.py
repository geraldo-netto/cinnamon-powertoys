#!/usr/bin/env python3
"""Build the distributable archive, byte for byte the same every time.

A release archive that differs between two builds of the same commit cannot be
verified by anyone: the checksum published beside it says only which machine
built it. So every entry here is written with a fixed timestamp, a fixed mode
and in sorted order, and the checksum is emitted alongside.

What goes in is the Cinnamon Spices submission layout and nothing else - the
payload directory plus the three wrapper assets - which is also what
tools/check-layout.sh already holds the working tree to. The repository's own
tooling, tests, policy and coverage output are development artifacts and are
not shipped; the archive is the evidence of that rather than the intention.
"""

import argparse
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys
import zipfile

# The earliest timestamp the zip format can record. Any fixed value would do;
# this one is conventionally "no time", so nothing reads a build date out of
# an archive that deliberately does not have one.
EPOCH = (1980, 1, 1, 0, 0, 0)

WRAPPER_ASSETS = ("info.json", "README.md", "screenshot.png")

# Regular files are readable by everyone and writable by their owner. The
# helper is the one entry that also has to be executable, because it is a
# program the user's session runs.
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
DIRECTORY_MODE = 0o755
EXECUTABLES = ("powertoys-helper",)


def fail(message: str) -> None:
    print(f"package FAIL  {message}", file=sys.stderr)
    raise SystemExit(1)


def run_check(root: Path, argv: list[str]) -> None:
    result = subprocess.run(argv, cwd=root)
    if result.returncode != 0:
        fail(f"{argv[1]} rejected the tree")


def read_metadata(root: Path, uuid: str) -> dict:
    path = root / "files" / uuid / "metadata.json"
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"{path}: {error}")
    for field in ("uuid", "name", "description", "version", "url", "cinnamon-version"):
        if not metadata.get(field):
            fail(f"{path}: metadata is missing {field}")
    if metadata["uuid"] != uuid:
        fail(f"{path}: metadata names {metadata['uuid']}, not {uuid}")
    version = str(metadata["version"])
    if any(character in version for character in "/ \t"):
        fail(f"{path}: version {version!r} cannot name a file")
    return metadata


def check_paths(root: Path, uuid: str, policy: Path, helper: str) -> None:
    """The helper path is written in the applet and in the action, and an
    archive that disagrees with the action installs a working applet whose
    every privileged change asks for a password again."""
    applet = (root / "files" / uuid / "applet.js").read_text(encoding="utf-8")
    if f'"{helper}"' not in applet:
        fail(f"applet.js does not run the installed helper {helper}")
    if not policy.is_file():
        fail(f"no polkit action at {policy}")
    if f">{helper}<" not in policy.read_text(encoding="utf-8"):
        fail(f"{policy.name} does not authorise the installed helper {helper}")


def payload(root: Path, uuid: str) -> list[tuple[str, Path]]:
    """Every shipped file and directory, as named in the archive."""
    base = root / "files" / uuid
    entries = [
        (f"{uuid}/", root),
        (f"{uuid}/files/", root / "files"),
        (f"{uuid}/files/{uuid}/", base),
    ]
    for path in sorted(base.rglob("*")):
        if path.is_dir():
            if not path.is_symlink():
                entries.append((f"{uuid}/files/{uuid}/{path.relative_to(base)}/", path))
            continue
        if not path.is_file() or path.is_symlink():
            fail(f"{path} is not a regular file")
        entries.append((f"{uuid}/files/{uuid}/{path.relative_to(base)}", path))
    for name in WRAPPER_ASSETS:
        asset = root / name
        if not asset.is_file():
            fail(f"missing wrapper asset {name}")
        entries.append((f"{uuid}/{name}", asset))
    return sorted(entries)


def write_archive(entries: list[tuple[str, Path]], destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source in entries:
            info = zipfile.ZipInfo(name, date_time=EPOCH)
            info.create_system = 3
            if source.is_dir() and not source.is_symlink():
                info.external_attr = ((stat.S_IFDIR | DIRECTORY_MODE) << 16) | 0x10
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, b"")
                continue
            executable = source.name in EXECUTABLES
            mode = EXECUTABLE_MODE if executable else FILE_MODE
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, source.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--helper", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    root = args.root.resolve()
    metadata = read_metadata(root, args.uuid)
    run_check(root, ["sh", "tools/check-layout.sh", args.uuid, "files"])
    policy = (root / args.policy).resolve()
    run_check(root, ["python3", "tools/check-policy.py", str(policy), args.helper])
    check_paths(root, args.uuid, policy, args.helper)

    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f"{args.uuid}-{metadata['version']}.zip"
    write_archive(payload(root, args.uuid), archive)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_name(archive.name + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")

    print(f"package ok   {archive}")
    print(f"             {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
