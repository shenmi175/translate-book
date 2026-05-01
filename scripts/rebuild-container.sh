#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="${TRANSLATE_BOOK_SERVICE_NAME:-translate-book}"
PORT_VALUE="${PORT:-8787}"
FOLLOW_LOGS=0
RESET_DATA=0
BASE_IMAGE="${TRANSLATE_BOOK_BASE_IMAGE:-node:22-bookworm-slim}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/rebuild-container.sh [--logs] [--reset-data]

Options:
  --logs        Rebuild, start the container, then follow container logs.
  --reset-data  Remove SQLite data and export cache before rebuilding.
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

clear_data() {
  log "Removing persisted SQLite state and export cache"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite-wal"
  rm -f "${PROJECT_DIR}/server/data/app.sqlite-shm"
  rm -rf "${PROJECT_DIR}/server/data/export-cache"
}

cd "$PROJECT_DIR"

log "Stopping existing container"
run_compose down

if [ "$RESET_DATA" -eq 1 ]; then
  clear_data
fi

log "Building and starting ${SERVICE_NAME}"
if ! run_compose up -d --build --force-recreate; then
  if run_docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
    log "Primary build failed. Retrying with local cached base image ${BASE_IMAGE} and BuildKit disabled"
    run_compose_build_without_buildkit
    run_compose up -d --force-recreate --no-build
  else
    printf '\nDocker could not fetch metadata for %s.\n' "${BASE_IMAGE}" >&2
    printf 'This is a Docker daemon DNS/network problem, not an application bug.\n' >&2
    printf 'Fix Docker networking first, then retry the rebuild script.\n' >&2
    printf 'Suggested checks:\n' >&2
    printf '  1. sudo docker pull %s\n' "${BASE_IMAGE}" >&2
    printf '  2. sudo systemctl restart docker\n' >&2
    printf '  3. If DNS keeps timing out, set Docker daemon DNS to 1.1.1.1 / 8.8.8.8 and restart Docker.\n' >&2
    exit 1
  fi
fi

log "Container is starting"
log "Open: http://localhost:${PORT_VALUE}"
log "Check container: $(run_docker ps --filter "name=^/${SERVICE_NAME}$" --format '{{.Names}} {{.Status}}')"

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  log "Following logs for ${SERVICE_NAME}"
  run_docker logs -f "${SERVICE_NAME}"
fi
