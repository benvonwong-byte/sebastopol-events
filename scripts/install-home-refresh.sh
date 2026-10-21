#!/bin/zsh
# Installs the morning home-connection refresh as a macOS launch agent.
# Runs scripts/home-refresh.sh every day at 5:40 AM local time (a Mac that
# was asleep runs it when it wakes). Remove it with:
#   launchctl bootout gui/$(id -u)/com.sebastopol-events.refresh
#   rm ~/Library/LaunchAgents/com.sebastopol-events.refresh.plist

set -euo pipefail
LABEL="com.sebastopol-events.refresh"
HERE="${0:A:h}"
RUNNER="$HOME/.sebastopol-refresh/home-refresh.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# The agent runs a copy that lives outside any synced folder.
mkdir -p "${RUNNER:h}"
cp "$HERE/home-refresh.sh" "$RUNNER"
chmod +x "$RUNNER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUNNER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>5</integer>
    <key>Minute</key><integer>40</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/sebastopol-refresh.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/sebastopol-refresh.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: daily at 5:40 AM, runner $RUNNER"
echo "run it now with: launchctl kickstart gui/$(id -u)/$LABEL"
