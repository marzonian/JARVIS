#!/bin/zsh
set -euo pipefail

MODE="${1:-normal}"
UIDN="$(id -u)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_FALLBACK="/Users/m3130/3130-runtime/mcnair-mindset"
PROJECT_MIRROR="/Users/m3130/Downloads/mcnair-mindset"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
SERVER_LABEL="gui/${UIDN}/ai.3130.server"
CLIENT_LABEL="gui/${UIDN}/ai.3130.client"
SERVER_PLIST="${LAUNCH_AGENT_DIR}/ai.3130.server.plist"
UI_URL="http://localhost:3131"
HEALTH_URL="${UI_URL}/api/health"
SERVER_LOG="/tmp/3130-server.log"
LAUNCH_LOG="/tmp/3130-launcher.log"
ICON_SYNC_LOG="/tmp/3130-icon-sync.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LAUNCH_LOG"
}

notify() {
  local message="$1"
  osascript -e "display notification \"${message}\" with title \"3130\"" >/dev/null 2>&1 || true
}

alert() {
  local message="$1"
  osascript -e "display alert \"3130\" message \"${message}\" as critical buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1 || true
}

open_ui() {
  if [[ "${LAUNCHER_NO_OPEN:-0}" == "1" ]]; then
    log "open_ui skipped via LAUNCHER_NO_OPEN"
    return 0
  fi

  # Prefer Safari first so launch is visible and frontmost on macOS.
  if open -a "Safari" "$UI_URL" >/dev/null 2>&1; then
    osascript -e 'tell application "Safari" to activate' >/dev/null 2>&1 || true
    log "open_ui success via Safari"
    return 0
  fi

  if open -a "Google Chrome" "$UI_URL" >/dev/null 2>&1; then
    osascript -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1 || true
    log "open_ui success via Chrome fallback"
    return 0
  fi

  if open "$UI_URL" >/dev/null 2>&1; then
    log "open_ui success via default browser fallback"
    return 0
  fi

  log "open_ui failed for all browser fallbacks"
  return 1
}

pick_npm() {
  if [[ -x "/opt/homebrew/bin/npm" ]]; then
    echo "/opt/homebrew/bin/npm"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    command -v npm
    return
  fi
  echo ""
}

is_healthy() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_health() {
  local timeout="${1:-60}"
  for _ in $(seq 1 "$timeout"); do
    if is_healthy; then
      return 0
    fi
    sleep 1
  done
  return 1
}

kill_port_3131() {
  local pids
  pids="$(lsof -t -n -P -iTCP:3131 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    kill ${=pids} >/dev/null 2>&1 || true
    sleep 1
    pids="$(lsof -t -n -P -iTCP:3131 -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      kill -9 ${=pids} >/dev/null 2>&1 || true
    fi
  fi
}

ensure_client_build() {
  if [[ -f "${PROJECT_DIR}/client/dist/index.html" ]]; then
    return 0
  fi
  local npm_bin
  npm_bin="$(pick_npm)"
  if [[ -z "$npm_bin" ]]; then
    return 1
  fi
  log "client build missing; running npm run build"
  (
    cd "$PROJECT_DIR"
    "$npm_bin" run build >> "$SERVER_LOG" 2>&1
  )
}

write_server_plist() {
  local npm_bin="$1"
  mkdir -p "$LAUNCH_AGENT_DIR"
  cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.3130.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npm_bin}</string>
    <string>run</string>
    <string>server</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${SERVER_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${SERVER_LOG}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
  chmod 644 "$SERVER_PLIST"
}

ensure_server_plist() {
  local npm_bin="$1"
  local refresh=0

  if [[ ! -f "$SERVER_PLIST" ]]; then
    refresh=1
  else
    if ! plutil -lint "$SERVER_PLIST" >/dev/null 2>&1; then
      refresh=1
    elif ! /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$SERVER_PLIST" 2>/dev/null | grep -q "$PROJECT_DIR"; then
      refresh=1
    elif ! /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SERVER_PLIST" 2>/dev/null | grep -q "$npm_bin"; then
      refresh=1
    fi
  fi

  if [[ "$refresh" -eq 1 ]]; then
    log "writing server LaunchAgent plist"
    write_server_plist "$npm_bin"
  fi
}

start_via_launchctl() {
  launchctl bootout "$CLIENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$SERVER_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UIDN}" "$SERVER_PLIST" >/dev/null 2>&1 || return 1
  launchctl enable "$SERVER_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "$SERVER_LABEL" >/dev/null 2>&1 || return 1
  return 0
}

start_direct() {
  local npm_bin="$1"
  kill_port_3131
  (
    cd "$PROJECT_DIR"
    nohup "$npm_bin" run server >> "$SERVER_LOG" 2>&1 &
  )
}

ensure_desktop_icon_sync() {
  if [[ "${SKIP_ICON_SYNC:-0}" == "1" ]]; then
    log "icon sync skipped via SKIP_ICON_SYNC"
    return 0
  fi

  local sync_script="${PROJECT_DIR}/scripts/sync-desktop-icons.sh"
  if [[ ! -x "$sync_script" ]]; then
    log "icon sync script missing: $sync_script"
    return 0
  fi

  if ! "$sync_script" --ensure >> "$ICON_SYNC_LOG" 2>&1; then
    log "icon sync failed; see ${ICON_SYNC_LOG}"
  fi
}

main() {
  touch "$LAUNCH_LOG" >/dev/null 2>&1 || true
  log "launcher mode=${MODE}"

  if [[ ! -d "$PROJECT_DIR" ]]; then
    if [[ -d "$PROJECT_FALLBACK" ]]; then
      PROJECT_DIR="$PROJECT_FALLBACK"
      log "project fallback selected: $PROJECT_DIR"
    elif [[ -d "$PROJECT_MIRROR" ]]; then
      PROJECT_DIR="$PROJECT_MIRROR"
      log "project mirror selected: $PROJECT_DIR"
    else
      log "project missing at $PROJECT_DIR"
      notify "Project folder missing: ${PROJECT_DIR}"
      alert "Project folder missing: ${PROJECT_DIR}"
      exit 1
    fi
  fi

  ensure_desktop_icon_sync

  local npm_bin
  npm_bin="$(pick_npm)"
  if [[ -z "$npm_bin" ]]; then
    log "npm not found"
    notify "npm not found. Install Node.js first."
    alert "npm not found. Install Node.js first."
    exit 1
  fi
  log "using npm=${npm_bin}"

  if [[ "$MODE" == "safe" ]]; then
    if ! is_healthy; then
      log "safe mode: server not healthy; starting direct"
      ensure_client_build || true
      start_direct "$npm_bin"
      if ! wait_for_health 75; then
        log "safe mode: health wait failed"
        notify "Safe start failed. Check /tmp/3130-server.log"
        alert "Safe start failed. Check /tmp/3130-server.log"
        exit 1
      fi
    fi
    if ! open_ui; then
      notify "3130 is running, but browser open failed. Open http://localhost:3131 manually."
      alert "3130 is running, but browser open failed. Open http://localhost:3131 manually."
      exit 1
    fi
    exit 0
  fi

  if is_healthy; then
    log "health already ok; opening UI"
    if ! open_ui; then
      notify "3130 is running, but browser open failed. Open http://localhost:3131 manually."
      alert "3130 is running, but browser open failed. Open http://localhost:3131 manually."
      exit 1
    fi
    exit 0
  fi

  ensure_client_build || true
  ensure_server_plist "$npm_bin"
  log "attempting launchctl start"

  if start_via_launchctl && wait_for_health 75; then
    log "launchctl path healthy"
    if ! open_ui; then
      notify "3130 started, but browser open failed. Open http://localhost:3131 manually."
      alert "3130 started, but browser open failed. Open http://localhost:3131 manually."
      exit 1
    fi
    exit 0
  fi

  log "launchctl start failed; fallback direct start"
  start_direct "$npm_bin"
  if wait_for_health 90; then
    log "direct start healthy"
    if ! open_ui; then
      notify "3130 started, but browser open failed. Open http://localhost:3131 manually."
      alert "3130 started, but browser open failed. Open http://localhost:3131 manually."
      exit 1
    fi
    exit 0
  fi

  log "start failed after retries"
  notify "Start failed. Check /tmp/3130-server.log"
  alert "Start failed. Check /tmp/3130-server.log and /tmp/3130-launcher.log"
  exit 1
}

main "$@"
