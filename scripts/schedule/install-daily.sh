#!/bin/sh
# Install the daily local intake refresh as a per-user launchd agent.
# Runs at 06:15 local time; see docs/REFRESH.md.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUN=$(command -v bun || true)
if [ -z "$BUN" ]; then
  echo "bun is not on PATH; install it or prepend ~/.bun/bin" >&2
  exit 1
fi
BUN_DIR=$(dirname "$BUN")
LABEL=com.civicsignal.refresh-daily
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/civicsignal-refresh.log"
TEMPLATE="$REPO/scripts/schedule/$LABEL.plist.template"

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__BUN__|$BUN|g" \
    -e "s|__BUN_DIR__|$BUN_DIR|g" \
    -e "s|__LOG__|$LOG|g" \
    "$TEMPLATE" > "$TARGET"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" > /dev/null

echo "installed $LABEL"
echo "  agent: $TARGET"
echo "  schedule: daily at 06:15 local"
echo "  log: $LOG"
echo "  run now: launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  remove:  scripts/schedule/uninstall-daily.sh"
