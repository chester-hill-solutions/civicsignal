"""Stream a portable, integrity-checked institution coverage workspace to private R2."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import tarfile
import tempfile
import time

PREFIX = "weekly/institution-coverage"
CHUNK_SIZE = 16 * 1024 * 1024
DEFAULT_ROOTS = (
    "data/corpus/briefing-notes",
    "data/corpus/departmental-report-documents", "data/corpus/departmental-report-editions",
    "data/corpus/eccc", "data/corpus/federal-bulk", "data/corpus/federal-disclosures",
    "data/corpus/federal-guidance", "data/corpus/federal-policy-editions",
    "data/corpus/federal-procurement", "data/corpus/federal-publication-catalogue",
    "data/corpus/federal-publication-checklists", "data/corpus/federal-publications",
    "data/corpus/federal-regulatory-plans", "data/corpus/federal-report-directories",
    "data/corpus/federal-source-inventory", "data/corpus/ircc-guidance-documents",
    "dist/briefing-notes", "dist/eccc", "dist/geds",
)
LEGACY_ROOTS = ("data/corpus/consultations", "dist/consultations")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_roots(roots, allowed=DEFAULT_ROOTS):
    names = list(roots)
    if not names or any(name not in allowed for name in names) or len(names) != len(set(names)):
        raise ValueError("Invalid or repeated coverage root")
    return sorted(names)


def inside(name, roots):
    return any(name == root or name.startswith(root + "/") for root in roots)


def member_name(name, roots):
    if ("\x00" in name or "\\" in name or not inside(name, roots)
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError(f"Invalid archive path: {name!r}")


def link_target(name, target, roots):
    if (not target or "\x00" in target or "\\" in target or target.startswith("/")
            or not inside(posixpath.normpath(posixpath.join(posixpath.dirname(name), target)), roots)):
        raise ValueError(f"Invalid archive link: {name!r}")


def ensure_resolved_inside(base, link, roots):
    resolved = link.resolve()
    if not any(resolved.is_relative_to(base / root) for root in roots):
        raise ValueError(f"Link resolves outside coverage roots: {link}")


def check_root_path(base, name):
    current = base
    for part in PurePosixPath(name).parts:
        current = current / part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise ValueError(f"Unsafe coverage root: {name}")


class ChunkWriter:
    def __init__(self, put, prefix=PREFIX):
        self.put = put
        self.prefix = prefix
        self.pending = bytearray()
        self.total = 0
        self.hash = hashlib.sha256()
        self.chunks = []

    def write(self, data):
        self.hash.update(data)
        self.total += len(data)
        self.pending.extend(data)
        while len(self.pending) >= CHUNK_SIZE:
            self.emit(CHUNK_SIZE)
        return len(data)

    def emit(self, length):
        data = bytes(self.pending[:length])
        del self.pending[:length]
        checksum = digest(data)
        key = f"{self.prefix}/chunks/{checksum}"
        self.put(key, data)
        self.chunks.append({"key": key, "sha256": checksum, "bytes": len(data)})


def entries(base, roots):
    def walk(path):
        info = path.lstat()
        yield path, info
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                # SQLite reconstructs shared memory; an empty WAL has no committed frames.
                if child.name == ".DS_Store" or child.name.endswith("-shm"):
                    continue
                if child.name.endswith("-wal") and child.lstat().st_size == 0:
                    continue
                yield from walk(child)
    for name in roots:
        check_root_path(base, name)
        yield from walk(base / name)


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def capture(root, roots, put_chunk, *, allowed=DEFAULT_ROOTS, prefix=PREFIX):
    """Call put_chunk(key, bytes) for each chunk, returning a manifest after the tree is stable."""
    base = Path(root).resolve(strict=True)
    names = checked_roots(roots, allowed)
    writer = ChunkWriter(put_chunk, prefix)
    observed = {}
    with gzip.GzipFile(fileobj=writer, mode="wb", filename="", mtime=0, compresslevel=1) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for path, info in entries(base, names):
                name = path.relative_to(base).as_posix()
                member_name(name, names)
                observed[name] = stamp(info)
                member = tarfile.TarInfo(name)
                member.mode = stat.S_IMODE(info.st_mode) & 0o777
                member.mtime = int(info.st_mtime)
                if stat.S_ISDIR(info.st_mode):
                    member.type = tarfile.DIRTYPE
                elif stat.S_ISLNK(info.st_mode):
                    member.type = tarfile.SYMTYPE
                    member.linkname = os.readlink(path)
                    link_target(name, member.linkname, names)
                    ensure_resolved_inside(base, path, names)
                elif stat.S_ISREG(info.st_mode):
                    member.size = info.st_size
                    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
                        if stamp(os.fstat(source.fileno())) != observed[name]:
                            raise ValueError(f"Coverage input changed: {name}")
                        archive.addfile(member, source)
                    continue
                else:
                    raise ValueError(f"Unsupported coverage input: {name}")
                archive.addfile(member)
    current = {p.relative_to(base).as_posix(): stamp(s) for p, s in entries(base, names)}
    if observed != current:
        raise ValueError("Coverage workspace changed during capture")
    if writer.pending:
        writer.emit(len(writer.pending))
    return {"schemaVersion": 1, "roots": names, "chunks": writer.chunks,
            "compressedBytes": writer.total, "sha256": writer.hash.hexdigest()}


def validate_manifest(manifest, *, allowed=DEFAULT_ROOTS + LEGACY_ROOTS, prefix=PREFIX):
    if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise ValueError("Invalid snapshot version")
    roots = checked_roots(manifest["roots"], allowed)
    chunks = manifest["chunks"]
    if not isinstance(chunks, list) or not chunks or not re.fullmatch("[0-9a-f]{64}", manifest["sha256"]):
        raise ValueError("Invalid snapshot chunks or hash")
    for index, chunk in enumerate(chunks):
        checksum, length = chunk["sha256"], chunk["bytes"]
        if (not re.fullmatch("[0-9a-f]{64}", checksum) or chunk["key"] != f"{prefix}/chunks/{checksum}"
                or type(length) is not int or not 1 <= length <= CHUNK_SIZE
                or (index < len(chunks) - 1 and length != CHUNK_SIZE)):
            raise ValueError("Invalid chunk descriptor")
    if (type(manifest["compressedBytes"]) is not int
            or sum(chunk["bytes"] for chunk in chunks) != manifest["compressedBytes"]):
        raise ValueError("Invalid snapshot size")
    return roots


class ChunkReader(io.RawIOBase):
    def __init__(self, chunks, get):
        self.descriptors = iter(chunks)
        self.get = get
        self.pending = memoryview(b"")
        self.hash = hashlib.sha256()

    def readable(self):
        return True

    def _read_verified(self, chunk):
        for attempt in range(3):
            try:
                raw = self.get(chunk["key"])
            except OSError:
                if attempt == 2:
                    raise
            else:
                if len(raw) == chunk["bytes"] and digest(raw) == chunk["sha256"]:
                    return raw
            if attempt < 2:
                time.sleep(0.25 * 2 ** attempt)
        raise ValueError(f"Corrupt snapshot chunk: {chunk['key']}")

    def readinto(self, target):
        if not self.pending:
            chunk = next(self.descriptors, None)
            if chunk is None:
                return 0
            raw = self._read_verified(chunk)
            self.hash.update(raw)
            self.pending = memoryview(raw)
        count = min(len(target), len(self.pending))
        target[:count] = self.pending[:count]
        self.pending = self.pending[count:]
        return count


def unpack(stream, stage, roots):
    links = {}
    seen = set()
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            name = member.name
            member_name(name, roots)
            if name in seen or (name in roots and not member.isdir()):
                raise ValueError(f"Invalid or duplicate member: {name}")
            seen.add(name)
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                path.mkdir(exist_ok=True)
            elif member.issym():
                link_target(name, member.linkname, roots)
                links[name] = member.linkname
            elif member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                with archive.extractfile(member) as source, path.open("xb") as target:
                    while data := source.read(1024 * 1024):
                        target.write(data)
                path.chmod(member.mode & 0o777)
                os.utime(path, (member.mtime, member.mtime))
            else:
                raise ValueError(f"Unsupported archive entry: {name}")
    if not set(roots).issubset(seen):
        raise ValueError("Snapshot lacks a declared root directory")
    # Defer all links until regular-file extraction is complete, eliminating link traversal.
    for name, target in links.items():
        (stage / name).symlink_to(target)
    for name in links:
        ensure_resolved_inside(stage, stage / name, roots)


def restore(root, manifest, read_chunk, *, allowed=DEFAULT_ROOTS + LEGACY_ROOTS, prefix=PREFIX):
    """Verify staged data before replacing only the manifest's declared workspace directories."""
    roots = validate_manifest(manifest, allowed=allowed, prefix=prefix)
    base = Path(root).resolve(strict=True)
    for name in roots:
        check_root_path(base, name)
    with tempfile.TemporaryDirectory(prefix=".coverage-restore-", dir=base) as temp:
        staging = Path(temp)
        tree = staging / "tree"
        tree.mkdir()
        reader = ChunkReader(manifest["chunks"], read_chunk)
        with io.BufferedReader(reader) as buffered, gzip.GzipFile(fileobj=buffered) as stream:
            unpack(stream, tree, roots)
            while rest := stream.read(1024 * 1024):
                if any(rest):
                    raise ValueError("Unexpected data after archive end")
            if reader.hash.hexdigest() != manifest["sha256"]:
                raise ValueError("Snapshot aggregate hash mismatch")

        old = staging / "originals"
        replaced = []
        try:
            for name in roots:
                target = base / name
                target.parent.mkdir(parents=True, exist_ok=True)
                backup = old / name
                if target.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    target.rename(backup)
                replaced.append((target, backup))
                (tree / name).rename(target)
        except BaseException:
            for target, backup in reversed(replaced):
                if target.exists():
                    target.rename(tree / target.relative_to(base))
                if backup.exists():
                    backup.rename(target)
            raise
