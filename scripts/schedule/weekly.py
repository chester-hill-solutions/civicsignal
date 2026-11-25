#!/usr/bin/env python3
"""Install, inspect, or remove the local weekly refresher on macOS."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
LABEL = "com.civicsignal.refresh-weekly"
TARGET = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")


def configuration():
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("bun must be on PATH to run the weekly intakes")
    programs = [Path(sys.executable).parent, Path(bun).parent]
    for program in ("cf", "pdftotext"):
        installed = shutil.which(program)
        if installed:
            programs.append(Path(installed).parent)
    paths = list(dict.fromkeys([*(str(p) for p in programs), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]))
    log = str(Path.home() / "Library/Logs/civicsignal-refresh-weekly.log")
    return {"Label": LABEL, "ProgramArguments": [sys.executable, "-B", str(ROOT / "scripts/refresh-weekly.py")],
            "WorkingDirectory": str(ROOT), "EnvironmentVariables": {"PATH": ":".join(paths), "LANG": "en_CA.UTF-8"},
            "StartCalendarInterval": {"Weekday": 6, "Hour": 9, "Minute": 0},
            "RunAtLoad": False, "ProcessType": "Standard", "StandardOutPath": log, "StandardErrorPath": log}


def manage(action):
    config = configuration() if action != "remove" else None
    if action == "print":
        sys.stdout.buffer.write(plistlib.dumps(config))
        return
    domain = f"gui/{os.getuid()}"
    identity = f"{domain}/{LABEL}"
    status = subprocess.run(["launchctl", "print", identity], capture_output=True, text=True)
    loaded = status.returncode == 0
    if action == "install" and loaded and TARGET.is_file() and plistlib.loads(TARGET.read_bytes()) == config:
        print(f"{LABEL} already installed")
        return
    if loaded and "state = running" in status.stdout:
        raise RuntimeError("The weekly refresh is running. Retry after the run completes.")
    if loaded:
        subprocess.run(["launchctl", "bootout", identity], check=True)
    if action == "remove":
        TARGET.unlink(missing_ok=True)
        return
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    Path(config["StandardOutPath"]).parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=TARGET.parent, delete=False) as pending:
        plistlib.dump(config, pending)
    os.replace(pending.name, TARGET)
    subprocess.run(["launchctl", "enable", identity], check=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(TARGET)], check=True)
    subprocess.run(["launchctl", "print", identity], stdout=subprocess.DEVNULL, check=True)
    print(f"Installed {LABEL} for Saturdays at 09:00 local time")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "remove", "print"])
    manage(parser.parse_args().action)
