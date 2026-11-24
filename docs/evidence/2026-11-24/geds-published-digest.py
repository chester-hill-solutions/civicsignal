#!/usr/bin/env python3
"""Digest the published GEDS tables so a replay can be compared before and after."""

import hashlib
import json
import sqlite3
import sys

PUBLISHED = {
    'persons': 'SELECT * FROM geds_persons ORDER BY person_id',
    'roles': 'SELECT * FROM geds_roles WHERE valid_to_seq IS NULL ORDER BY role_id',
    'organizations': 'SELECT * FROM geds_organizations WHERE valid_to_seq IS NULL ORDER BY org_id',
    'changes': 'SELECT * FROM geds_changes ORDER BY id',
    'snapshots': "SELECT seq, snapshot_id, status, effective_at FROM geds_snapshots "
                 "WHERE status = 'published' ORDER BY seq",
}

COUNTS = {
    'people': 'SELECT COUNT(*) FROM geds_persons',
    'roles': 'SELECT COUNT(*) FROM geds_roles WHERE valid_to_seq IS NULL',
    'organizations': 'SELECT COUNT(*) FROM geds_organizations WHERE valid_to_seq IS NULL',
    'changes': 'SELECT COUNT(*) FROM geds_changes',
    'publishedSnapshots': "SELECT COUNT(*) FROM geds_snapshots WHERE status = 'published'",
    'discardedSnapshots': "SELECT COUNT(*) FROM geds_snapshots WHERE status = 'discarded'",
}


def table_digest(db, sql):
    digest = hashlib.sha256()
    rows = 0
    for row in db.execute(sql):
        digest.update(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode())
        digest.update(b'\n')
        rows += 1
    return {'rows': rows, 'sha256': digest.hexdigest()}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'dist/geds/geds.sqlite'
    db = sqlite3.connect(path)
    tables = {name: table_digest(db, sql) for name, sql in PUBLISHED.items()}
    tables['counts'] = {name: db.execute(sql).fetchone()[0] for name, sql in COUNTS.items()}
    print(json.dumps({'database': path, 'tables': tables}, indent=2))


if __name__ == '__main__':
    main()
