#!/bin/sh
set -eu

DATA_DIR="${TRANSLATE_BOOK_DATA_DIR:-/app/server/data}"
TOKEN_FILE="${MARKDOWN_TRANSLATOR_ACCESS_TOKEN_FILE:-${DATA_DIR}/runtime/access-token}"
AUTO_GENERATE="${MARKDOWN_TRANSLATOR_AUTO_GENERATE_ACCESS_TOKEN:-1}"

log() {
  printf '[entrypoint] %s\n' "$*"
}

normalize_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

persist_token() {
  token_value="$1"
  token_dir="$(dirname "$TOKEN_FILE")"
  umask 077
  mkdir -p "$token_dir"
  printf '%s\n' "$token_value" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
}

if [ -n "${MARKDOWN_TRANSLATOR_ACCESS_TOKEN:-}" ]; then
  log "Using access token from MARKDOWN_TRANSLATOR_ACCESS_TOKEN."
elif [ -s "$TOKEN_FILE" ]; then
  MARKDOWN_TRANSLATOR_ACCESS_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  export MARKDOWN_TRANSLATOR_ACCESS_TOKEN
  log "Loaded persisted access token from ${TOKEN_FILE}."
elif normalize_bool "$AUTO_GENERATE"; then
  MARKDOWN_TRANSLATOR_ACCESS_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  export MARKDOWN_TRANSLATOR_ACCESS_TOKEN
  persist_token "$MARKDOWN_TRANSLATOR_ACCESS_TOKEN"
  log "Generated a new access token and stored it at ${TOKEN_FILE}."
  log "Read it with: docker exec translate-book cat ${TOKEN_FILE}"
else
  log "No access token provided and automatic generation is disabled."
fi

exec "$@"
