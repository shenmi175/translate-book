#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="${TRANSLATE_BOOK_SERVICE_NAME:-translate-book}"
PORT_VALUE="${PORT:-8787}"
BACKUP_INPUT=""
FOLLOW_LOGS=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/restore-state-backup.sh --latest-nonempty [--logs]
  ./scripts/restore-state-backup.sh server/data/backups/pre-rebuild-YYYYMMDD-HHMMSS [--logs]

Options:
  --latest-nonempty  Restore the newest backup that contains at least one task row.
  --dry-run          Show which backup would be restored without changing files.
  --logs             Follow container logs after restore and restart.
  --help             Show this help message.
EOF
}

log() {
  printf '[restore] %s\n' "$*"
}

fail() {
  printf '[restore] error: %s\n' "$*" >&2
  exit 1
}

ensure_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

count_sqlite_tasks() {
  db_path="$1"
  if [ ! -s "$db_path" ] || ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi

  SQLITE_PATH="$db_path" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    let db;
    try {
      db = new DatabaseSync(process.env.SQLITE_PATH, { readOnly: true });
      const row = db.prepare("SELECT COUNT(*) AS count FROM tasks").get();
      console.log(Number(row?.count || 0));
    } catch {
      console.log(0);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  ' 2>/dev/null || printf '0'
}

resolve_latest_nonempty_backup() {
  backups_dir="${PROJECT_DIR}/server/data/backups"
  [ -d "$backups_dir" ] || fail "No backups directory found: ${backups_dir}"

  best_dir=""
  for candidate in "$backups_dir"/pre-rebuild-* "$backups_dir"/pre-restore-*; do
    [ -d "$candidate" ] || continue
    [ -s "${candidate}/app.sqlite" ] || continue
    task_count="$(count_sqlite_tasks "${candidate}/app.sqlite")"
    if [ "$task_count" -gt 0 ]; then
      best_dir="$candidate"
    fi
  done

  [ -n "$best_dir" ] || fail "No non-empty SQLite backup was found."
  printf '%s\n' "$best_dir"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --latest-nonempty)
      BACKUP_INPUT="__latest_nonempty__"
      ;;
    --logs)
      FOLLOW_LOGS=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      [ -z "$BACKUP_INPUT" ] || fail "Only one backup path can be provided."
      BACKUP_INPUT="$1"
      ;;
  esac
  shift
done

[ -n "$BACKUP_INPUT" ] || {
  usage >&2
  exit 1
}

cd "$PROJECT_DIR"

if [ "$BACKUP_INPUT" = "__latest_nonempty__" ]; then
  BACKUP_DIR="$(resolve_latest_nonempty_backup)"
else
  BACKUP_DIR="$BACKUP_INPUT"
  case "$BACKUP_DIR" in
    /*) ;;
    *) BACKUP_DIR="${PROJECT_DIR}/${BACKUP_DIR}" ;;
  esac
fi

[ -s "${BACKUP_DIR}/app.sqlite" ] || fail "Backup app.sqlite was not found: ${BACKUP_DIR}/app.sqlite"
BACKUP_TASK_COUNT="$(count_sqlite_tasks "${BACKUP_DIR}/app.sqlite")"
[ "$BACKUP_TASK_COUNT" -gt 0 ] || fail "Backup has no task rows: ${BACKUP_DIR}"

DATA_DIR="${PROJECT_DIR}/server/data"
CURRENT_BACKUP_DIR="${DATA_DIR}/backups/pre-restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$CURRENT_BACKUP_DIR"

log "Selected backup: ${BACKUP_DIR} (${BACKUP_TASK_COUNT} tasks)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run only; no files were changed."
  exit 0
fi

ensure_command docker

DOCKER_PREFIX=""
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_PREFIX="sudo"
  else
    fail "Docker is unavailable. Run with a user that can access /var/run/docker.sock."
  fi
fi

run_docker() {
  if [ -n "$DOCKER_PREFIX" ]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

run_compose() {
  if run_docker compose version >/dev/null 2>&1; then
    run_docker compose "$@"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    if [ -n "$DOCKER_PREFIX" ]; then
      sudo docker-compose "$@"
    else
      docker-compose "$@"
    fi
    return
  fi

  fail "Docker Compose is not available."
}

log "Stopping container before restore"
run_compose down

for filename in app.sqlite app.sqlite-wal app.sqlite-shm db.json runtime/.env runtime/access-token; do
  source_path="${DATA_DIR}/${filename}"
  if [ -e "$source_path" ]; then
    mkdir -p "$(dirname "${CURRENT_BACKUP_DIR}/${filename}")"
    cp -p "$source_path" "${CURRENT_BACKUP_DIR}/${filename}" 2>/dev/null || true
  fi
done
log "Backed up current state to ${CURRENT_BACKUP_DIR}"

for filename in app.sqlite app.sqlite-wal app.sqlite-shm; do
  source_path="${DATA_DIR}/${filename}"
  if [ -e "$source_path" ]; then
    mv "$source_path" "${CURRENT_BACKUP_DIR}/${filename}.replaced"
  fi
done

cp -p "${BACKUP_DIR}/app.sqlite" "${DATA_DIR}/app.sqlite"
if [ -s "${BACKUP_DIR}/app.sqlite-wal" ]; then
  cp -p "${BACKUP_DIR}/app.sqlite-wal" "${DATA_DIR}/app.sqlite-wal"
fi

for filename in runtime/.env runtime/access-token; do
  if [ -e "${BACKUP_DIR}/${filename}" ]; then
    mkdir -p "$(dirname "${DATA_DIR}/${filename}")"
    cp -p "${BACKUP_DIR}/${filename}" "${DATA_DIR}/${filename}"
  fi
done

log "Starting container"
run_compose up -d --force-recreate --no-build

attempt=1
while [ "$attempt" -le 20 ]; do
  if run_docker exec "$SERVICE_NAME" node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8787/health");
    if (!response.ok) {
      process.exit(1);
    }
  ' >/dev/null 2>&1; then
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

RESTORED_TASK_COUNT="$(count_sqlite_tasks "${DATA_DIR}/app.sqlite")"
log "Restored SQLite tasks=${RESTORED_TASK_COUNT}"
if [ "$RESTORED_TASK_COUNT" -lt "$BACKUP_TASK_COUNT" ]; then
  fail "Restore verification failed: expected at least ${BACKUP_TASK_COUNT} tasks."
fi

log "Open: http://localhost:${PORT_VALUE}"

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  run_docker logs -f "$SERVICE_NAME"
fi
