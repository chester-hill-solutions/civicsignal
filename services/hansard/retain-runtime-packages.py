"""Keep the locked Bun dependencies needed by the intake and its Vitest check."""
import json
from pathlib import Path
import shutil


def main():
    root = Path.cwd()
    modules = root / "node_modules"
    store = modules / ".bun"
    vendor = root / "vendor"
    names = [*json.loads((root / "package.json").read_bytes())["dependencies"], "vitest"]
    pending = [modules / name for name in names]
    retained = set()
    visited = set()
    while pending:
        target = pending.pop().resolve()
        if target.is_relative_to(store):
            directory = store / target.relative_to(store).parts[0]
            retained.add(directory)
        elif target.is_relative_to(vendor):
            directory = target / "node_modules"
        else:
            continue
        if directory in visited:
            continue
        visited.add(directory)
        pending.extend(link for link in directory.rglob("*") if link.is_symlink())
    for directory in store.iterdir():
        if directory.is_dir() and not directory.is_symlink() and directory not in retained:
            shutil.rmtree(directory)


if __name__ == "__main__":
    main()
