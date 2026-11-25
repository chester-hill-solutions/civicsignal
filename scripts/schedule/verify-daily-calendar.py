"""Correlate one regular daily launch with its dated report and serving checks on macOS."""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "dist/refresh"
LABEL = "com.civicsignal.refresh-daily"
TORONTO = ZoneInfo("America/Toronto")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def observe():
    with (Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")).open("rb") as stream:
        plist = plistlib.load(stream)
    calendar = plist["StartCalendarInterval"]
    require(calendar == {"Hour": 6, "Minute": 15} and plist["Label"] == LABEL
            and not plist.get("RunAtLoad") and Path(plist["WorkingDirectory"]) == ROOT
            and plist["ProgramArguments"][1:] == [str(ROOT / "scripts/refresh-daily.ts")],
            "Installed job differs from the regular daily schedule or runner")
    status = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], check=True,
                            capture_output=True, text=True).stdout
    fields = dict(re.findall(r"^\t(state|runs|last exit code) = (.+)$", status, re.MULTILINE))
    require({"state", "runs", "last exit code"} <= fields.keys(), "Missing launchd job status fields")
    log = Path(plist["StandardOutPath"])
    stat = log.stat()
    full = json.loads((REPORTS / "latest-full.json").read_bytes())
    return {"observedAt": datetime.now(timezone.utc).isoformat(), "label": LABEL,
            "calendar": calendar, "status": fields, "logBytes": stat.st_size,
            "logInode": stat.st_ino, "lastFullStartedAt": full["startedAt"]}, log


def verify(before, after, log, day, reports=REPORTS):
    target = datetime(day.year, day.month, day.day, 6, 15, tzinfo=TORONTO)
    require(datetime.fromisoformat(before["observedAt"]) < target < datetime.fromisoformat(after["observedAt"]),
            "The observations must bracket the scheduled time")
    require(before["label"] == after["label"] == LABEL and before["calendar"] == after["calendar"],
            "Schedule identity changed between observations")
    require(before["status"]["state"] == after["status"]["state"] == "not running"
            and int(after["status"]["runs"]) == int(before["status"]["runs"]) + 1
            and after["status"]["last exit code"] == "0", "Expected one completed successful launch")
    require(before["logInode"] == after["logInode"] and before["logBytes"] < after["logBytes"],
            "The installed agent log rotated, was truncated, or has no new output")
    with log.open("rb") as stream:
        stream.seek(before["logBytes"])
        entries = [json.loads(line) for line in stream.read(after["logBytes"] - before["logBytes"]).splitlines()
                   if line.startswith(b"{")]
    require(len(entries) == 1 and entries[0].get("ok") is True, "Expected one successful dated report in the agent log")
    path = Path(entries[0]["report"]).resolve()
    require(path.parent == reports.resolve() and re.fullmatch(r"\d{4}-\d{2}-\d{2}T[\d-]+Z\.json", path.name),
            "Agent log did not identify a dated report in the daily report directory")
    data = path.read_bytes()
    report = json.loads(data)
    require(report.get("scope") == "full" and report.get("ok") is True
            and before["lastFullStartedAt"] != report["startedAt"] == after["lastFullStartedAt"],
            "Dated full run does not match the latest completed attempt")
    started = datetime.fromisoformat(report["startedAt"])
    finished = datetime.fromisoformat(report["finishedAt"])
    require(0 <= (started - target).total_seconds() < 60 and started <= finished <= datetime.fromisoformat(after["observedAt"]),
            "Dated run did not start in the scheduled minute or finish within the observed interval")
    checks = report["workerVerification"]
    require(checks.get("ok") is True and checks.get("passedTests") == 4, "Expected four authenticated Worker checks")
    steps = report["steps"]
    require([s["name"] for s in steps] == ["consultations", "committee-calls", "funding"]
            and all(s.get("ok") is True and s.get("serving", {}).get("database") for s in steps),
            "Expected successful serving checks for all three daily intakes")
    return {"calendarTarget": target.isoformat(), "before": before, "after": after,
            "report": {"file": path.name, "sha256": hashlib.sha256(data).hexdigest(), "startedAt": report["startedAt"],
                       "finishedAt": report["finishedAt"], "durationMs": report["durationMs"]},
            "serving": {s["name"]: s["serving"] for s in steps}, "workerVerification": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="Before-launch observation to verify; omit to record one")
    parser.add_argument("--date", type=date.fromisoformat, help="Scheduled Toronto date to verify (YYYY-MM-DD)")
    args = parser.parse_args()
    if bool(args.baseline) != bool(args.date):
        parser.error("--baseline and --date are required together")
    try:
        current, log = observe()
        result = verify(json.loads(args.baseline.read_bytes()), current, log, args.date) if args.baseline else current
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Daily calendar verification: {error}\n")


if __name__ == "__main__":
    main()
