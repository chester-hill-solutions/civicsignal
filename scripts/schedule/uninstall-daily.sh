#!/bin/sh
# Remove the daily refresh launchd agent. Local corpus data is left in place.
set -eu

LABEL=com.civicsignal.refresh-daily
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$TARGET"
echo "removed $LABEL"
