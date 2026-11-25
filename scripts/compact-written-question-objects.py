#!/usr/bin/env python3
"""Safely reclaim allocation from immutable HTML objects in a WQ archive."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Callable


DIGEST_NAME = re.compile(r"^[0-9a-f]{64}$")
HTML_START = re.compile(rb"\s*(?:\xef\xbb\xbf)?\s*<(?:!doctype\s+html\b|html\b|head\b|body\b)", re.I)
UF_COMPRESSED = getattr(stat, "UF_COMPRESSED", 0x20)


class UnsupportedCompression(RuntimeError):
    pass


class NoCompressionBenefit(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def allocated_bytes(path: Path) -> int:
    return path.stat(follow_symlinks=False).st_blocks * 512


def is_compressed(path: Path) -> bool:
    return bool(path.stat(follow_symlinks=False).st_flags & UF_COMPRESSED)


def ditto_compress(source: Path, destination: Path, ditto: str) -> None:
    subprocess.run(
        [ditto, "--noclone", "--hfsCompression", str(source), str(destination)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def verify_filesystem_support(
    objects: Path,
    *,
    ditto: str,
    compress: Callable[[Path, Path, str], None],
    compressed: Callable[[Path], bool],
    allocation: Callable[[Path], int],
) -> None:
    """Fail closed unless this volume can compress a known compressible file."""
    payload = (b"<html><body>WQ compression capability probe</body></html>\n" * 32768)
    fd, source_name = tempfile.mkstemp(prefix=".wq-probe-source-", dir=objects)
    source = Path(source_name)
    destination = source.with_name(source.name + ".compressed")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        source.chmod(0o600)
        source_allocation = allocation(source)
        compress(source, destination, ditto)
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise UnsupportedCompression("Filesystem compression probe did not create a standalone file")
        if info.st_size != len(payload) or stat.S_IMODE(info.st_mode) != 0o600:
            raise UnsupportedCompression("Filesystem compression probe did not preserve size and permissions")
        if sha256_file(destination) != hashlib.sha256(payload).hexdigest():
            raise UnsupportedCompression("Filesystem compression probe changed the bytes")
        if not compressed(destination) or allocation(destination) >= source_allocation:
            raise UnsupportedCompression("Filesystem does not provide flagged allocation-saving compression")
    finally:
        source.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)


def is_html(path: Path) -> bool:
    with path.open("rb") as stream:
        prefix = stream.read(8192)
    return bool(HTML_START.match(prefix))


def source_identity(path: Path) -> tuple[int, int, int, int, int]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Expected a regular file: {path.name}")
    if info.st_nlink != 1:
        raise ValueError(f"Refusing hard-linked object: {path.name}")
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size, stat.S_IMODE(info.st_mode))


def compact_one(
    path: Path,
    *,
    ditto: str,
    compress: Callable[[Path, Path, str], None] = ditto_compress,
    compressed: Callable[[Path], bool] = is_compressed,
    allocation: Callable[[Path], int] = allocated_bytes,
) -> dict[str, int | str]:
    name = path.name
    if not DIGEST_NAME.fullmatch(name):
        raise ValueError(f"Invalid checksum object name: {name}")
    before = source_identity(path)
    if sha256_file(path) != name:
        raise ValueError(f"Object bytes do not match checksum filename: {name}")
    if not is_html(path):
        return {"status": "not_html", "sha256": name, "logicalBytes": before[3], "allocatedBefore": allocation(path)}
    if compressed(path):
        return {"status": "already_compressed", "sha256": name, "logicalBytes": before[3], "allocatedBefore": allocation(path)}

    old_allocated = allocation(path)
    fd, temp_name = tempfile.mkstemp(prefix=".wq-compact-", dir=path.parent)
    os.close(fd)
    temp = Path(temp_name)
    try:
        temp.unlink()
        compress(path, temp, ditto)
        temp_info = temp.lstat()
        if not stat.S_ISREG(temp_info.st_mode) or temp_info.st_nlink != 1:
            raise ValueError(f"Compressor did not create a standalone regular file: {name}")
        if sha256_file(temp) != name:
            raise ValueError(f"Compressed copy checksum mismatch: {name}")
        if temp_info.st_size != before[3]:
            raise ValueError(f"Compressed copy logical size mismatch: {name}")
        if stat.S_IMODE(temp_info.st_mode) != before[4]:
            raise ValueError(f"Compressed copy permissions mismatch: {name}")
        if not compressed(temp):
            raise NoCompressionBenefit(f"Compression flag was not set for this object: {name}")
        new_allocated = allocation(temp)
        if new_allocated >= old_allocated:
            raise NoCompressionBenefit(f"Compressed copy does not save allocation: {name}")
        fsync_file(temp)

        if source_identity(path) != before:
            raise ValueError(f"Source changed while compressing: {name}")
        os.replace(temp, path)
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

        # Verify the installed inode as well as the staged copy before recording success.
        after = source_identity(path)
        if after[3:] != before[3:] or sha256_file(path) != name or not compressed(path):
            raise ValueError(f"Installed compressed object failed verification: {name}")
        final_allocated = allocation(path)
        if final_allocated >= old_allocated:
            raise ValueError(f"Installed object did not reduce allocation: {name}")
        return {
            "status": "compacted", "sha256": name, "logicalBytes": before[3],
            "allocatedBefore": old_allocated, "allocatedAfter": final_allocated,
        }
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def compact_root(
    root: Path,
    *,
    limit: int | None = None,
    if_supported: bool = False,
    ditto_path: str | None = None,
    platform_name: str | None = None,
    compress: Callable[[Path, Path, str], None] = ditto_compress,
    compressed: Callable[[Path], bool] = is_compressed,
    allocation: Callable[[Path], int] = allocated_bytes,
    support_probe: Callable[..., None] = verify_filesystem_support,
) -> dict:
    if limit is not None and limit < 0:
        raise ValueError("--limit must be nonnegative")
    objects = root / "objects"
    if not objects.is_dir():
        raise FileNotFoundError(f"WQ object directory does not exist: {objects}")
    chosen_ditto = ditto_path or shutil.which("ditto")
    if (platform_name or os.uname().sysname) != "Darwin" or not chosen_ditto:
        if if_supported:
            return {"status": "skipped_unsupported", "reason": "requires macOS ditto", "examined": 0, "compacted": 0}
        raise UnsupportedCompression("Object compaction requires macOS and ditto")

    results = []
    with (root / "writer.lock").open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Written-questions writer lock is already held") from exc
        try:
            support_probe(objects, ditto=chosen_ditto, compress=compress, compressed=compressed, allocation=allocation)
        except UnsupportedCompression as exc:
            if if_supported:
                return {"status": "skipped_unsupported", "reason": str(exc), "examined": 0, "compacted": 0}
            raise
        except OSError:
            raise
        for path in sorted(objects.iterdir(), key=lambda item: item.name):
            if not DIGEST_NAME.fullmatch(path.name):
                continue
            if limit is not None and len(results) >= limit:
                break
            try:
                result = compact_one(path, ditto=chosen_ditto, compress=compress, compressed=compressed, allocation=allocation)
            except NoCompressionBenefit as exc:
                result = {"status": "no_savings", "sha256": path.name, "logicalBytes": path.lstat().st_size,
                          "reason": str(exc)}
            except UnsupportedCompression as exc:
                if if_supported:
                    raise RuntimeError(f"Filesystem behavior changed after successful probe: {exc}") from exc
                raise
            results.append(result)

    compacted = [result for result in results if result["status"] == "compacted"]
    outcome_counts: dict[str, int] = {}
    rolling = hashlib.sha256()
    for result in results:
        status = str(result["status"])
        outcome_counts[status] = outcome_counts.get(status, 0) + 1
        rolling.update(str(result.get("sha256", "")).encode("ascii"))
        rolling.update(b"\0")
        rolling.update(str(result.get("logicalBytes", 0)).encode("ascii"))
        rolling.update(b"\n")
    return {
        "status": "ok", "root": str(root), "examined": len(results),
        "compacted": len(compacted),
        "outcomes": outcome_counts,
        "logicalBytes": sum(int(result["logicalBytes"]) for result in compacted),
        "allocatedBefore": sum(int(result["allocatedBefore"]) for result in compacted),
        "allocatedAfter": sum(int(result["allocatedAfter"]) for result in compacted),
        "freedBytes": sum(int(result["allocatedBefore"]) - int(result["allocatedAfter"]) for result in compacted),
        "processedNamesAndSizesSha256": rolling.hexdigest(),
        "sampleAfter": compacted[-1] if compacted else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/corpus/written-questions"))
    parser.add_argument("--limit", type=int, help="Process at most this many checksum-named files")
    parser.add_argument("--if-supported", action="store_true", help="Report a skip on non-macOS or unsupported compression filesystems")
    args = parser.parse_args()
    try:
        print(json.dumps(compact_root(args.root, limit=args.limit, if_supported=args.if_supported), sort_keys=True))
    except Exception as exc:
        parser.exit(1, f"written-question object compaction failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
