#!/usr/bin/env python3
"""Seed the private weekly statutes export. Stdout is the manifest reference."""
import argparse
from hashlib import md5
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services/statutes-export"))
from run import PREFIX, command, verify_export  # noqa: E402

SPEC = importlib.util.spec_from_file_location("coverage_bootstrap", Path(__file__).with_name("bootstrap-institution-coverage.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=REPO)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    source = args.workspace / "dist/statutes-local"
    verified = verify_export(source)
    present = {} if args.dry_run else bootstrap.existing_chunks(PREFIX)

    def put(key, data, content_type):
        if not args.dry_run and present.get(key) != (len(data), md5(data, usedforsecurity=False).hexdigest()):
            bootstrap.upload(key, data, content_type)

    with tempfile.TemporaryDirectory(prefix="statutes-export-bootstrap-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "archive"
        archive.mkdir()
        generation = verified["generation"]
        shutil.copytree(source / generation, archive / generation, symlinks=True)
        (archive / "current").symlink_to(generation, target_is_directory=True)
        shutil.copystat(source / "current", archive / "current", follow_symlinks=False)
        shutil.copystat(source, archive)
        if verify_export(archive) != verified:
            raise ValueError("The staged statutes seed differs from the verified generation.")
        print(command("node", "scripts/check-corpus-invariants.mjs", "--exports", str(archive / "current"),
                      "--require-exports").strip(), file=sys.stderr)
        print(f"Verified six export hashes for Justice Canada {verified['revision']}.", file=sys.stderr)
        ref = bootstrap.publish(workspace, 3, put, roots=("archive",), prefix=PREFIX)
    sys.stdout.buffer.write(bootstrap.snapshot.canonical(ref) + b"\n")


if __name__ == "__main__":
    main()
