#!/bin/zsh
set -euo pipefail

UIDN="$(id -u)"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENT_DIR}/ai.3130.pm2-resurrect.plist"
LABEL="gui/${UIDN}/ai.3130.pm2-resurrect"
LOG_PATH="/tmp/3130-pm2-resurrect.log"

pick_pm2() {
  if [[ -x "/opt/homebrew/bin/pm2" ]]; then
    echo "/opt/homebrew/bin/pm2"
    return 0
  fi
  if command -v pm2 >/dev/null 2>&1; then
    command -v pm2
    return 0
  fi
  return 1
}

PM2_BIN="$(pick_pm2 || true)"
if [[ -z "${PM2_BIN}" ]]; then
  echo "[ERR] pm2 not found in PATH or /opt/homebrew/bin/pm2" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENT_DIR"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.3130.pm2-resurrect</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PM2_BIN}</string>
    <string>resurrect</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PM2_HOME</key>
    <string>${HOME}/.pm2</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
plutil -lint "$PLIST_PATH" >/dev/null

launchctl bootout "$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UIDN}" "$PLIST_PATH" >/dev/null
launchctl enable "$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$LABEL" >/dev/null 2>&1 || true

echo "[OK] PM2 user LaunchAgent installed: $PLIST_PATH"
echo "[OK] PM2 resurrect triggered. Log: $LOG_PATH"
