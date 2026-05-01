#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
MODE="auto"
DEV_MODE=0
FOLLOW_LOGS=0
RESET_DATA=0
SKIP_SYSTEM_PACKAGES=0
SKIP_INSTALL=0
PORT_VALUE="${PORT:-8787}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-run.sh [--docker | --native] [--dev] [--logs] [--reset-data] [--skip-system-packages] [--no-install]

Modes:
  --docker   Use Docker Compose. This is the default when Docker is available.
  --native   Run directly on the host machine.

Options:
  --dev                    Native mode only. Start the Vite + API development processes.
  --logs                   Docker mode only. Follow container logs after startup.
  --reset-data             Docker mode only. Remove persisted SQLite data and export cache before rebuilding.
  --skip-system-packages   Native mode only. Skip apt-based system package installation.
  --no-install             Native mode only. Skip npm dependency installation.
  --help                   Show this help message.
EOF
}

log() {
  printf '[install-run] %s\n' "$*"
}

warn() {
  printf '[install-run] warning: %s\n' "$*" >&2
}

fail() {
  printf '[install-run] error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

docker_available() {
  if ! command_exists docker; then
    return 1
  fi
  docker info >/dev/null 2>&1
}

ensure_node_runtime() {
  command_exists node || fail "Node.js 22+ is required for native mode."
  command_exists npm || fail "npm is required for native mode."

  major_version="$(node -p "process.versions.node.split('.')[0]")"
  case "$major_version" in
    ''|*[!0-9]*)
      fail "Unable to detect the current Node.js version."
      ;;
  esac

  if [ "$major_version" -lt 22 ]; then
    fail "Native mode requires Node.js 22+, but detected $(node -v)."
  fi
}

detect_apt_browser_package() {
  if ! command_exists apt-cache; then
    return 1
  fi

  if apt-cache show chromium 2>/dev/null | grep -q '^Package: chromium$'; then
    printf 'chromium\n'
    return 0
  fi

  if apt-cache show chromium-browser 2>/dev/null | grep -q '^Package: chromium-browser$'; then
    if apt-cache show chromium-browser 2>/dev/null | grep -qiE 'snap|transitional|dummy'; then
      warn "Ignoring Ubuntu chromium-browser snap transition package. Install Google Chrome/Chromium manually or set MARKDOWN_TRANSLATOR_CHROME_BIN for native PDF export."
      return 1
    fi
    printf 'chromium-browser\n'
    return 0
  fi

  return 1
}

repair_failed_chromium_snap_package() {
  command_exists dpkg-query || return 0

  for package_name in chromium-browser chromium-codecs-ffmpeg-extra; do
    status="$(dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null || true)"
    case "$status" in
      *"half-installed"*|*"unpacked"*|*"half-configured"*|*"triggers-pending"*|*"triggers-awaited"*)
        warn "Removing incomplete ${package_name} package left by Ubuntu's snap-based Chromium installer."
        sudo dpkg --remove --force-remove-reinstreq "$package_name" >/dev/null 2>&1 || true
        ;;
    esac
  done
}

install_native_system_packages() {
  [ "$SKIP_SYSTEM_PACKAGES" -eq 0 ] || return 0

  if ! command_exists apt-get; then
    warn "apt-get was not found. Skipping automatic system package installation."
    return 0
  fi

  if ! command_exists sudo; then
    warn "sudo was not found. Skipping automatic system package installation."
    return 0
  fi

  repair_failed_chromium_snap_package

  packages=""
  browser_package=""

  if ! command_exists python3; then
    packages="${packages} python3"
  fi
  if ! command_exists pandoc; then
    packages="${packages} pandoc"
  fi
  if ! command_exists pdfunite; then
    packages="${packages} poppler-utils"
  fi
  if ! command_exists fc-list; then
    packages="${packages} fontconfig"
  fi
  packages="${packages} fonts-noto-cjk"

  if ! command_exists chromium \
    && ! command_exists chromium-browser \
    && ! command_exists google-chrome \
    && ! command_exists google-chrome-stable \
    && ! command_exists microsoft-edge \
    && ! command_exists microsoft-edge-stable; then
    browser_package="$(detect_apt_browser_package || true)"
    if [ -n "$browser_package" ]; then
      browser_package="${browser_package}"
    else
      warn "Could not find an apt package for Chromium. Native PDF export may require MARKDOWN_TRANSLATOR_CHROME_BIN."
    fi
  fi

  normalized_packages="$(printf '%s\n' "$packages" | xargs 2>/dev/null || true)"
  if [ -z "$normalized_packages" ] && [ -z "$browser_package" ]; then
    log "Native system packages already look complete"
    return 0
  fi

  sudo apt-get update
  if [ -n "$normalized_packages" ]; then
    log "Installing native system packages: $normalized_packages"
    sudo apt-get install -y --no-install-recommends $normalized_packages
  fi
  if [ -n "$browser_package" ]; then
    log "Installing native browser package: $browser_package"
    if ! sudo apt-get install -y --no-install-recommends "$browser_package"; then
      warn "Browser package installation failed. Native PDF export may require MARKDOWN_TRANSLATOR_CHROME_BIN, but the app can still run."
    fi
  fi
}

run_npm_install() {
  install_dir="$1"
  install_label="$2"
  install_prefix="$3"

  if [ "$SKIP_INSTALL" -eq 1 ]; then
    log "Skipping ${install_label} dependency installation"
    return 0
  fi

  log "Installing ${install_label} dependencies"
  if [ -n "$install_prefix" ]; then
    if npm ci --prefix "$install_prefix"; then
      return 0
    fi
    warn "npm ci failed for ${install_label}; retrying with npm install"
    npm install --prefix "$install_prefix"
    return 0
  fi

  (
    cd "$install_dir"
    if npm ci; then
      exit 0
    fi
    warn "npm ci failed for ${install_label}; retrying with npm install"
    npm install
  )
}

run_native() {
  ensure_node_runtime
  install_native_system_packages
  run_npm_install "$PROJECT_DIR" "root" ""
  run_npm_install "$PROJECT_DIR" "web" "web"

  cd "$PROJECT_DIR"
  export TRANSLATE_BOOK_DATA_DIR="${PROJECT_DIR}/server/data"

  if [ "$DEV_MODE" -eq 1 ]; then
    log "Starting native development mode"
    exec "${PROJECT_DIR}/scripts/container-entrypoint.sh" npm run dev
  fi

  log "Building frontend bundle for native runtime"
  npm run build --prefix web
  log "Starting native runtime"
  log "Open: http://localhost:${PORT_VALUE}"
  exec "${PROJECT_DIR}/scripts/container-entrypoint.sh" npm start
}

run_docker_mode() {
  cd "$PROJECT_DIR"
  docker_args=""
  if [ "$FOLLOW_LOGS" -eq 1 ]; then
    docker_args="${docker_args} --logs"
  fi
  if [ "$RESET_DATA" -eq 1 ]; then
    docker_args="${docker_args} --reset-data"
  fi
  # shellcheck disable=SC2086
  exec "${PROJECT_DIR}/scripts/rebuild-container.sh" $docker_args
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docker)
      MODE="docker"
      ;;
    --native)
      MODE="native"
      ;;
    --dev)
      DEV_MODE=1
      ;;
    --logs)
      FOLLOW_LOGS=1
      ;;
    --reset-data)
      RESET_DATA=1
      ;;
    --skip-system-packages)
      SKIP_SYSTEM_PACKAGES=1
      ;;
    --no-install)
      SKIP_INSTALL=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

if [ "$DEV_MODE" -eq 1 ] && [ "$MODE" = "docker" ]; then
  fail "--dev is only supported together with --native."
fi

if [ "$FOLLOW_LOGS" -eq 1 ] && [ "$MODE" = "native" ]; then
  warn "--logs only applies to Docker mode and will be ignored."
fi

if [ "$RESET_DATA" -eq 1 ] && [ "$MODE" = "native" ]; then
  warn "--reset-data only applies to Docker mode and will be ignored."
fi

if [ "$MODE" = "auto" ]; then
  if docker_available; then
    MODE="docker"
  else
    MODE="native"
  fi
fi

log "Selected mode: ${MODE}"

if [ "$MODE" = "docker" ]; then
  run_docker_mode
fi

run_native
