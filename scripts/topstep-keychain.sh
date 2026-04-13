#!/usr/bin/env zsh
set -euo pipefail

SERVICE="3130_topstep_api_key"
ACCOUNT="${USER:-m3130}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/topstep-keychain.sh set [--value <key> | --from-env | --from-clipboard]
  scripts/topstep-keychain.sh set-username [--value <username> | --from-env | --from-clipboard]
  scripts/topstep-keychain.sh status
  scripts/topstep-keychain.sh delete

Notes:
  - set without flags attempts: TOPSTEP_API_KEY env, then clipboard.
  - set-username writes TOPSTEP_API_USERNAME in local .env.
  - key value is never printed.
USAGE
}

detect_value() {
  local v=""
  local env_key="${3:-TOPSTEP_API_KEY}"
  if [[ "${1:-}" == "--value" ]]; then
    v="${2:-}"
  elif [[ "${1:-}" == "--from-env" ]]; then
    v="${(P)env_key:-}"
  elif [[ "${1:-}" == "--from-clipboard" ]]; then
    v="$(pbpaste 2>/dev/null || true)"
  else
    v="${(P)env_key:-}"
    if [[ -z "$v" ]]; then
      v="$(pbpaste 2>/dev/null || true)"
    fi
  fi
  printf "%s" "$v"
}

cmd="${1:-}"
case "$cmd" in
  set)
    shift || true
    key="$(detect_value "${1:-}" "${2:-}" "TOPSTEP_API_KEY")"
    key="$(printf "%s" "$key" | tr -d '\r' | sed 's/[[:space:]]*$//')"
    if [[ -z "$key" || "${#key}" -lt 12 ]]; then
      echo "No valid key found. Copy key to clipboard or pass --value."
      exit 1
    fi
    security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$key" >/dev/null
    echo "Topstep key saved to Keychain service '$SERVICE' for account '$ACCOUNT'."
    ;;
  set-username)
    shift || true
    username="$(detect_value "${1:-}" "${2:-}" "TOPSTEP_API_USERNAME")"
    username="$(printf "%s" "$username" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [[ -z "$username" ]]; then
      echo "No username found. Pass --value, set TOPSTEP_API_USERNAME, or copy to clipboard."
      exit 1
    fi
    env_file=".env"
    [[ -f "$env_file" ]] || touch "$env_file"
    tmp_file="$(mktemp)"
    awk -v v="$username" '
      BEGIN { done=0 }
      /^TOPSTEP_API_USERNAME=/ {
        print "TOPSTEP_API_USERNAME=" v
        done=1
        next
      }
      { print }
      END {
        if (!done) print "TOPSTEP_API_USERNAME=" v
      }
    ' "$env_file" > "$tmp_file"
    mv "$tmp_file" "$env_file"
    echo "Updated $env_file with TOPSTEP_API_USERNAME."
    ;;
  status)
    if security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
      echo "Topstep key is present in Keychain ($SERVICE)."
    else
      echo "Topstep key not found in Keychain ($SERVICE)."
      exit 1
    fi
    if [[ -f ".env" ]] && grep -q '^TOPSTEP_API_USERNAME=.*[^[:space:]]' ".env"; then
      echo "Topstep username is present in .env."
    else
      echo "Topstep username is not set in .env."
    fi
    ;;
  delete)
    security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
    echo "Topstep key removed from Keychain ($SERVICE)."
    ;;
  *)
    usage
    exit 1
    ;;
esac
