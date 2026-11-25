"""Run the daily committee step while holding the publication lock used by the weekly job."""
import fcntl
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
lock_path = root / "dist/refresh/committee-publication.lock"
lock_path.parent.mkdir(parents=True, exist_ok=True)
with lock_path.open("a") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("The weekly committee refresh is active. Retry the daily committee step after it completes.")
    # Keep the lock in the process that runs acquisition, publication and readback.
    os.set_inheritable(lock.fileno(), True)
    bun, temporary = sys.argv[1:]
    os.execv(bun, [bun, str(root / "scripts/refresh-daily.ts"), "--locked-committee-step", temporary])
