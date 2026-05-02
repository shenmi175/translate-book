#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="${TRANSLATE_BOOK_SERVICE_NAME:-translate-book}"
PORT_VALUE="${PORT:-8787}"
FOLLOW_LOGS=0
RESET_DATA=0
BACKUP_DATA=1
SMOKE_TEST=1
NO_BUILD=0
BASE_IMAGE="${TRANSLATE_BOOK_BASE_IMAGE:-node:22-bookworm-slim}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/rebuild-container.sh [--logs] [--reset-data] [--no-backup] [--no-smoke] [--no-build]

Options:
  --logs        Rebuild, start the container, then follow container logs.
  --reset-data  Remove SQLite data and export cache before rebuilding.
  --no-backup   Skip the pre-rebuild SQLite backup.
  --no-smoke    Skip the post-rebuild health and persistence checks.
  --no-build    Start the last built image without contacting Docker Hub.
  --help        Show this help message.
EOF
}

log() {
  printf '[rebuild] %s\n' "$*"
}

ensure_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --logs)
      FOLLOW_LOGS=1
      ;;
    --reset-data)
      RESET_DATA=1
      ;;
    --no-backup)
      BACKUP_DATA=0
      ;;
    --no-smoke)
      SMOKE_TEST=0
      ;;
    --no-build)
      NO_BUILD=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

ensure_command docker

DOCKER_PREFIX=""
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    if sudo docker info >/dev/null 2>&1; then
      DOCKER_PREFIX="sudo"
    else
      printf 'Docker is unavailable. Run with a user that can access /var/run/docker.sock.\n' >&2
      exit 1
    fi
  else
    printf 'Docker is unavailable and sudo was not found.\n' >&2
    exit 1
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

  printf 'Docker Compose is not available.\n' >&2
  exit 1
}

run_compose_build_without_buildkit() {
  if run_docker compose version >/dev/null 2>&1; then
    if [ -n "$DOCKER_PREFIX" ]; then
      sudo env DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose build
    else
      env DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose build
    fi
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    if [ -n "$DOCKER_PREFIX" ]; then
      sudo env DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker-compose build
    else
      env DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker-compose build
    fi
    return
  fi

  printf 'Docker Compose is not available.\n' >&2
  exit 1
}

print_docker_network_help() {
  cat >&2 <<EOF

Docker could not fetch metadata for ${BASE_IMAGE}.
This is a Docker daemon DNS/network problem, not an application bug.

Your shell/browser can use a proxy while the Docker daemon still connects directly.
In an Ubuntu VM with v2rayN on the host, configure Docker daemon proxy inside the VM:

  1. Enable "Allow LAN" in v2rayN and confirm the HTTP proxy port, for example 7890 or 10809.
  2. In the Ubuntu VM, find the host/gateway address:
       ip route | awk '/default/ {print \$3; exit}'
  3. Verify the VM can reach the host proxy:
       curl -I -x http://<gateway-ip>:<proxy-port> https://registry-1.docker.io/v2/
     A 401 response is OK; timeout/refused means the proxy address or LAN setting is wrong.
  4. Configure Docker daemon proxy:
       sudo mkdir -p /etc/systemd/system/docker.service.d
       sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'PROXY'
       [Service]
       Environment="HTTP_PROXY=http://<gateway-ip>:<proxy-port>"
       Environment="HTTPS_PROXY=http://<gateway-ip>:<proxy-port>"
       Environment="NO_PROXY=localhost,127.0.0.1,::1"
       PROXY
       sudo systemctl daemon-reload
       sudo systemctl restart docker
       sudo docker pull ${BASE_IMAGE}

If DNS still fails after proxying Docker, set Docker daemon DNS in /etc/docker/daemon.json:

  {
    "dns": ["1.1.1.1", "8.8.8.8"]
  }

Then run:
  sudo systemctl restart docker
  ./scripts/rebuild-container.sh --logs

To bring the app back with the last successfully built image while fixing networking:
  ./scripts/rebuild-container.sh --no-build
EOF
}

count_sqlite_table() {
  table_name="$1"
  db_path="${PROJECT_DIR}/server/data/app.sqlite"
  if [ ! -s "$db_path" ] || ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi

  SQLITE_PATH="$db_path" SQLITE_TABLE="$table_name" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const table = process.env.SQLITE_TABLE || "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      process.exit(2);
    }
    let db;
    try {
      db = new DatabaseSync(process.env.SQLITE_PATH);
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
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

count_task_asset_dirs() {
  tasks_dir="${PROJECT_DIR}/server/data/tasks"
  if [ ! -d "$tasks_dir" ]; then
    printf '0'
    return
  fi

  find "$tasks_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '
}

is_container_running() {
  run_docker ps \
    --filter "name=^/${SERVICE_NAME}$" \
    --filter "status=running" \
    --format '{{.Names}}' | grep -qx "$SERVICE_NAME"
}

has_container_api_key() {
  is_container_running || return 1
  run_docker exec "$SERVICE_NAME" sh -lc 'test -s /app/server/data/runtime/.env && grep -Eq "^MARKDOWN_TRANSLATOR_API_KEY=.+$" /app/server/data/runtime/.env' >/dev/null 2>&1
}

has_host_api_key() {
  env_path="${PROJECT_DIR}/server/data/runtime/.env"
  if grep -Eq "^MARKDOWN_TRANSLATOR_API_KEY=.+$" "$env_path" >/dev/null 2>&1; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n grep -Eq "^MARKDOWN_TRANSLATOR_API_KEY=.+$" "$env_path" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

has_api_key() {
  has_container_api_key || has_host_api_key
}

clear_data() {
  log "Removing persisted SQLite state and export cache"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite-wal"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite-shm"
  rm -rf "${PROJECT_DIR}/server/data/export-cache"
}

path_exists_for_backup() {
  [ -e "$1" ] && return 0
  command -v sudo >/dev/null 2>&1 && sudo -n test -e "$1" 2>/dev/null
}

copy_file_for_backup() {
  source_path="$1"
  target_path="$2"
  mkdir -p "$(dirname "$target_path")"
  if cp -p "$source_path" "$target_path" 2>/dev/null; then
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n cp -p "$source_path" "$target_path" 2>/dev/null; then
    sudo -n chown "$(id -u):$(id -g)" "$target_path" 2>/dev/null || true
    return
  fi
  log "Warning: could not back up ${source_path}; check file permissions."
}

backup_data() {
  data_dir="${PROJECT_DIR}/server/data"
  has_backup_source=0
  for filename in app.sqlite app.sqlite-wal app.sqlite-shm db.json runtime/.env runtime/access-token; do
    if path_exists_for_backup "${data_dir}/${filename}"; then
      has_backup_source=1
      break
    fi
  done

  if [ "$has_backup_source" -ne 1 ]; then
    log "No SQLite/db.json state found to back up"
    return
  fi

  backup_dir="${data_dir}/backups/pre-rebuild-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"

  if is_container_running; then
    container_backup_dir="/app/server/data/backups/$(basename "$backup_dir")"
    if run_docker exec -u node -e SQLITE_BACKUP_TARGET="${container_backup_dir}/app.sqlite" "$SERVICE_NAME" node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      import { DatabaseSync } from "node:sqlite";
      const target = process.env.SQLITE_BACKUP_TARGET;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      const db = new DatabaseSync("/app/server/data/app.sqlite");
      const quotedTarget = db.prepare("SELECT quote(?) AS value").get(target).value;
      db.exec("VACUUM INTO " + quotedTarget);
      db.close();
    ' >/dev/null 2>&1; then
      run_docker exec "$SERVICE_NAME" sh -lc "
        mkdir -p '${container_backup_dir}/runtime'
        for filename in runtime/.env runtime/access-token db.json; do
          if [ -e \"/app/server/data/\${filename}\" ]; then
            cp -p \"/app/server/data/\${filename}\" \"${container_backup_dir}/\${filename}\"
          fi
        done
        chown -R node:node '${container_backup_dir}' 2>/dev/null || true
      " >/dev/null 2>&1 || true
      log "Backed up live SQLite snapshot to ${backup_dir}"
      return
    fi
    log "Warning: live SQLite snapshot failed; falling back to file copy."
  fi

  for filename in app.sqlite app.sqlite-wal app.sqlite-shm db.json runtime/.env runtime/access-token; do
    if path_exists_for_backup "${data_dir}/${filename}"; then
      copy_file_for_backup "${data_dir}/${filename}" "${backup_dir}/${filename}"
    fi
  done
  log "Backed up persisted state to ${backup_dir}"
}

run_smoke_test() {
  log "Running smoke test"
  health_ok=0
  attempt=1
  while [ "$attempt" -le 20 ]; do
    if run_docker exec "$SERVICE_NAME" node --input-type=module -e '
      const response = await fetch("http://127.0.0.1:8787/health");
      if (!response.ok) {
        process.exit(1);
      }
    ' >/dev/null 2>&1; then
      health_ok=1
      break
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  if [ "$health_ok" -ne 1 ]; then
    printf 'Smoke test failed: health endpoint did not become ready.\n' >&2
    exit 1
  fi

  post_task_count="$(count_sqlite_table tasks)"
  log "Smoke: SQLite tasks before=${PRE_TASK_COUNT:-0} after=${post_task_count}"
  if [ "${RESET_DATA}" -eq 0 ] && [ "${PRE_TASK_COUNT:-0}" -gt 0 ] && [ "$post_task_count" -lt "${PRE_TASK_COUNT:-0}" ]; then
    printf 'Smoke test failed: task count dropped after rebuild (%s -> %s). Refusing to treat rebuild as successful.\n' "${PRE_TASK_COUNT}" "$post_task_count" >&2
    exit 1
  fi

  if [ "${PRE_HAS_API_KEY:-0}" -eq 1 ] && ! has_container_api_key; then
    printf 'Smoke test failed: API key existed before rebuild but is missing after rebuild.\n' >&2
    exit 1
  fi

  log "Smoke test passed"
}

cd "$PROJECT_DIR"

PRE_TASK_COUNT="$(count_sqlite_table tasks)"
PRE_TASK_ASSET_COUNT="$(count_task_asset_dirs)"
PRE_HAS_API_KEY=0
if has_api_key; then
  PRE_HAS_API_KEY=1
fi
log "Preflight: SQLite tasks=${PRE_TASK_COUNT}, task assets=${PRE_TASK_ASSET_COUNT}, API key=$([ "$PRE_HAS_API_KEY" -eq 1 ] && printf present || printf not-detected)"

if [ "${RESET_DATA}" -eq 0 ] && [ "${PRE_TASK_COUNT:-0}" -eq 0 ] && [ "${PRE_TASK_ASSET_COUNT:-0}" -gt 0 ]; then
  log "Warning: task source assets exist but SQLite has no task rows. If tasks disappeared, run ./scripts/restore-state-backup.sh --latest-nonempty."
fi

if [ "$BACKUP_DATA" -eq 1 ]; then
  backup_data
fi

log "Stopping existing container"
run_compose down

if [ "$RESET_DATA" -eq 1 ]; then
  clear_data
fi

if [ "$NO_BUILD" -eq 1 ]; then
  log "Starting ${SERVICE_NAME} from the last built image without rebuilding"
  run_compose up -d --force-recreate --no-build
else
  log "Building and starting ${SERVICE_NAME}"
  if ! run_compose up -d --build --force-recreate; then
    if run_docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
      log "Primary build failed. Retrying with local cached base image ${BASE_IMAGE} and BuildKit disabled"
      run_compose_build_without_buildkit
      run_compose up -d --force-recreate --no-build
    else
      print_docker_network_help
      exit 1
    fi
  fi
fi

log "Container is starting"
log "Open: http://localhost:${PORT_VALUE}"
log "Check container: $(run_docker ps --filter "name=^/${SERVICE_NAME}$" --format '{{.Names}} {{.Status}}')"

if [ "$SMOKE_TEST" -eq 1 ]; then
  run_smoke_test
fi

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  log "Following logs for ${SERVICE_NAME}"
  run_docker logs -f "${SERVICE_NAME}"
fi
