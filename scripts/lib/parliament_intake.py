"""Persist the publisher bytes and checked inventories for a parliamentary intake."""
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_atomic(path, payload):
    atomic_write(path, (json.dumps(payload, ensure_ascii=False, indent=2) + '\n').encode())


def archive_inventory(output, session, collect, fetch):
    output = Path(output)
    root = output.parent / 'sources'
    sources = []

    def archive_fetch(url):
        body = fetch(url)
        digest = sha256(body).hexdigest()
        target = root / 'objects' / digest[:2] / digest
        if not target.exists() or sha256(target.read_bytes()).hexdigest() != digest:
            atomic_write(target, body)
        sources.append({'url': url, 'sha256': digest, 'bytes': len(body)})
        return body

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.with_suffix(output.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _publish(output, root, collect(session, archive_fetch), sources)


def _publish(output, root, packet, sources):
    packet['sources'] = sources
    contents = (json.dumps(packet, ensure_ascii=False, indent=2) + '\n').encode()
    # Retain each reconciled inventory and its source hashes across later refreshes.
    snapshot = root / 'inventories' / packet['collection'] / (sha256(contents).hexdigest() + '.json')
    atomic_write(snapshot, contents)
    atomic_write(output, contents)
    return packet
