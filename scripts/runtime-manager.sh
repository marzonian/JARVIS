#!/bin/zsh
set -euo pipefail
setopt typeset_silent

CMD="${1:-doctor}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL_DIR="/Users/m3130/3130-runtime/mcnair-mindset"
MIRROR_DIR="/Users/m3130/Downloads/mcnair-mindset"
ENV_FILE="${CANONICAL_DIR}/.env"
CONFIG_FILE="${CANONICAL_DIR}/config.yaml"
SERVER_PLIST="$HOME/Library/LaunchAgents/ai.3130.server.plist"
PM2_AGENT_PLIST="$HOME/Library/LaunchAgents/ai.3130.pm2-resurrect.plist"
PM2_AGENT_LABEL="gui/$(id -u)/ai.3130.pm2-resurrect"
UI_URL="http://localhost:3131"
HEALTH_URL="${UI_URL}/api/health"
LAUNCHER="${CANONICAL_DIR}/scripts/desktop-launcher.sh"
ICON_SYNC="${CANONICAL_DIR}/scripts/sync-desktop-icons.sh"
PM2_AGENT_INSTALL="${CANONICAL_DIR}/scripts/install-pm2-user-agent.sh"

say_ok() { echo "[OK] $*"; }
say_warn() { echo "[WARN] $*"; }
say_err() { echo "[ERR] $*"; }

require_canonical() {
  if [[ ! -d "$CANONICAL_DIR" ]]; then
    say_err "Canonical runtime missing: $CANONICAL_DIR"
    exit 1
  fi
}

ensure_orchestrator_env() {
  touch "$ENV_FILE"
  local changed=0
  for kv in \
    "ORCHESTRATOR_MODE=hybrid" \
    "ORCHESTRATOR_EXECUTOR=codex" \
    "ORCHESTRATOR_ARCHITECT=codex" \
    "ORCHESTRATOR_PLAN_PROVIDER=codex" \
    "ORCHESTRATOR_RUNNER_PROVIDER=codex"
  do
    local key="${kv%%=*}"
    if rg -q "^${key}=" "$ENV_FILE"; then
      sed -i '' "s|^${key}=.*|${kv}|g" "$ENV_FILE"
    else
      echo "$kv" >> "$ENV_FILE"
    fi
    changed=1
  done
  if [[ "$changed" -eq 1 ]]; then
    say_ok "Orchestrator keys enforced in .env"
  fi
}

ensure_config_yaml() {
  cat > "$CONFIG_FILE" <<'EOF'
orchestrator:
  mode: hybrid
  roles:
    executor:
      provider: codex
      title: lead_execution_engineer
    architect:
      provider: codex
      title: chief_architect
  routing:
    plan_phase:
      reasoner_provider: codex
      require_architecture_prompt: true
    execute_phase:
      runner_provider: codex
      terminal_owner: codex
  runtime:
    canonical_project_dir: /Users/m3130/3130-runtime/mcnair-mindset
    mirror_project_dir: /Users/m3130/Downloads/mcnair-mindset
    launcher_url: http://localhost:3131
EOF
  say_ok "config.yaml refreshed"
}

ensure_mirror_symlink() {
  if [[ -L "$MIRROR_DIR" ]]; then
    local target
    target="$(readlink "$MIRROR_DIR" || true)"
    if [[ "$target" == "$CANONICAL_DIR" ]]; then
      say_ok "Mirror symlink already points to canonical runtime"
      return 0
    fi
    say_warn "Mirror symlink target mismatch ($target), replacing"
    rm -f "$MIRROR_DIR"
  elif [[ -d "$MIRROR_DIR" ]]; then
    local backup="${MIRROR_DIR}.archive.$(date +%Y%m%d-%H%M%S)"
    mv "$MIRROR_DIR" "$backup"
    say_warn "Existing mirror directory archived to $backup"
  elif [[ -e "$MIRROR_DIR" ]]; then
    rm -f "$MIRROR_DIR"
  fi
  ln -s "$CANONICAL_DIR" "$MIRROR_DIR"
  say_ok "Mirror symlink created: $MIRROR_DIR -> $CANONICAL_DIR"
}

ensure_server_agent_path() {
  if [[ -f "$LAUNCHER" ]]; then
    LAUNCHER_NO_OPEN=1 /bin/zsh "$LAUNCHER" normal >/dev/null 2>&1 || true
  fi
  if [[ -f "$SERVER_PLIST" ]]; then
    local wd
    wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$SERVER_PLIST" 2>/dev/null || true)"
    if [[ "$wd" == "$CANONICAL_DIR" ]]; then
      say_ok "LaunchAgent working dir is canonical"
    else
      say_warn "LaunchAgent working dir is '$wd' (expected '$CANONICAL_DIR')"
    fi
  else
    say_warn "Server LaunchAgent plist missing: $SERVER_PLIST"
  fi
}

icon_source_path() {
  local active="${CANONICAL_DIR}/scripts/assets/3130_active.icns"
  local fallback="${CANONICAL_DIR}/scripts/assets/3130_v2.icns"
  if [[ -f "$active" ]]; then
    echo "$active"
  else
    echo "$fallback"
  fi
}

icons_in_sync() {
  local source
  source="$(icon_source_path)"
  if [[ ! -f "$source" ]]; then
    return 1
  fi
  local source_hash
  source_hash="$(shasum -a 256 "$source" | awk '{print $1}')"
  local icon
  for icon in \
    "$HOME/Desktop/3130.app/Contents/Resources/3130.icns" \
    "$HOME/Desktop/3130 Safe Mode.app/Contents/Resources/3130.icns"
  do
    if [[ ! -f "$icon" ]]; then
      return 1
    fi
    local icon_hash
    icon_hash="$(shasum -a 256 "$icon" | awk '{print $1}')"
    if [[ "$icon_hash" != "$source_hash" ]]; then
      return 1
    fi
  done
  return 0
}

ensure_desktop_icons() {
  if [[ ! -x "$ICON_SYNC" ]]; then
    say_warn "Icon sync script missing: $ICON_SYNC"
    return 0
  fi
  /bin/zsh "$ICON_SYNC" --ensure >/tmp/3130-icon-sync-runtime.log 2>&1 || true
  if icons_in_sync; then
    say_ok "Desktop icon is synchronized"
  else
    say_warn "Desktop icon could not be verified"
  fi
}

ensure_pm2_startup() {
  if ! command -v pm2 >/dev/null 2>&1 && [[ ! -x "/opt/homebrew/bin/pm2" ]]; then
    say_warn "pm2 is not installed; skipping PM2 startup enforcement"
    return 0
  fi
  pm2 save >/dev/null 2>&1 || true
  if [[ ! -x "$PM2_AGENT_INSTALL" ]]; then
    say_warn "PM2 agent installer missing: $PM2_AGENT_INSTALL"
    return 0
  fi
  /bin/zsh "$PM2_AGENT_INSTALL" >/tmp/3130-pm2-agent-install.log 2>&1 || {
    say_warn "PM2 user LaunchAgent install failed (see /tmp/3130-pm2-agent-install.log)"
    return 0
  }
  if [[ -f "$PM2_AGENT_PLIST" ]]; then
    say_ok "PM2 user startup agent installed"
  fi
}

health_check() {
  local ok=0
  for _ in {1..45}; do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "$ok" -eq 1 ]]; then
    say_ok "Health endpoint reachable: $HEALTH_URL"
  else
    say_err "Health endpoint unreachable: $HEALTH_URL"
    return 1
  fi
}

doctor() {
  require_canonical
  local failed=0

  if [[ -L "$MIRROR_DIR" ]]; then
    local target
    target="$(readlink "$MIRROR_DIR" || true)"
    if [[ "$target" == "$CANONICAL_DIR" ]]; then
      say_ok "Mirror symlink is correct"
    else
      say_err "Mirror symlink points to '$target'"
      failed=1
    fi
  else
    say_err "Mirror path is not a symlink: $MIRROR_DIR"
    failed=1
  fi

  if [[ -f "$ENV_FILE" ]]; then
    for key in ANTHROPIC_API_KEY DISCORD_BOT_TOKEN ORCHESTRATOR_MODE ORCHESTRATOR_EXECUTOR ORCHESTRATOR_PLAN_PROVIDER; do
      if rg -q "^${key}=" "$ENV_FILE"; then
        say_ok ".env has ${key}"
      else
        say_err ".env missing ${key}"
        failed=1
      fi
    done
  else
    say_err ".env missing at $ENV_FILE"
    failed=1
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    say_ok "config.yaml present"
  else
    say_err "config.yaml missing"
    failed=1
  fi

  if [[ -f "$SERVER_PLIST" ]]; then
    local wd
    wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$SERVER_PLIST" 2>/dev/null || true)"
    if [[ "$wd" == "$CANONICAL_DIR" ]]; then
      say_ok "LaunchAgent path stable"
    else
      say_err "LaunchAgent path drift: $wd"
      failed=1
    fi
  else
    say_err "LaunchAgent plist missing"
    failed=1
  fi

  if command -v pm2 >/dev/null 2>&1 || [[ -x "/opt/homebrew/bin/pm2" ]]; then
    if [[ -f "$PM2_AGENT_PLIST" ]]; then
      say_ok "PM2 user startup LaunchAgent present"
    else
      say_err "PM2 user startup LaunchAgent missing"
      failed=1
    fi
  fi

  if icons_in_sync; then
    say_ok "Desktop icon matches active branding"
  else
    say_err "Desktop icon drift detected"
    failed=1
  fi

  if ! health_check; then
    failed=1
  fi

  if [[ "$failed" -ne 0 ]]; then
    say_err "Runtime doctor found issues"
    return 1
  fi
  say_ok "Runtime doctor passed"
  return 0
}

enforce() {
  require_canonical
  ensure_mirror_symlink
  ensure_orchestrator_env
  ensure_config_yaml
  ensure_server_agent_path
  ensure_desktop_icons
  ensure_pm2_startup
  health_check
  doctor
}

case "$CMD" in
  doctor)
    doctor
    ;;
  enforce|repair|harden)
    enforce
    ;;
  health)
    health_check
    ;;
  *)
    echo "Usage: zsh scripts/runtime-manager.sh [doctor|enforce|health]"
    exit 2
    ;;
esac
