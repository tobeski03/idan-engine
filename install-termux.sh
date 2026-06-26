#!/usr/bin/env bash
# =============================================================================
# install-termux.sh — idan-engine one-command Termux installer
#
# Usage (first install):
#   bash install-termux.sh <repo-url> [pairing-token] [target-dir]
#
#   pairing-token  optional — auto-generated if omitted
#   target-dir     optional — defaults to ~/idan-engine
#
# Usage (re-run / update in place):
#   bash install-termux.sh        # re-uses existing install
#
# The installer is fully non-interactive. All production config is baked in.
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[idan]${RESET} $*"; }
success() { echo -e "${GREEN}[idan]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[idan]${RESET} $*"; }
error()   { echo -e "${RED}[idan]${RESET} $*" >&2; }

# ── Args ───────────────────────────────────────────────────────────────────────
REPO_URL="${1:-}"
PAIRING_TOKEN="${2:-}"
TARGET_DIR="${3:-${HOME}/idan-engine}"

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   idan-engine  —  Termux Installer   ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════╝${RESET}"
echo -e ""

# ── Step 1: System packages ───────────────────────────────────────────────────
info "Updating package lists..."
pkg update -y -o Dpkg::Options::="--force-confnew" 2>/dev/null || pkg update -y

_pkg_install() {
  local pkg="$1"
  if ! command -v "$2" &>/dev/null; then
    info "Installing ${pkg}..."
    pkg install -y "$pkg"
  else
    success "${pkg} already installed."
  fi
}

_pkg_install git          git
_pkg_install nodejs-lts   node
_pkg_install curl         curl
_pkg_install termux-api   termux-battery-status

# ── Step 2: Termux:API companion app check ────────────────────────────────────
if ! pm list packages 2>/dev/null | grep -q "package:com.termux.api"; then
  warn "Termux:API companion app is not installed on this device."
  warn "Device controls (flashlight, volume, notifications) will not work."
  warn "Install it from F-Droid (same source as your Termux) to enable them."
fi

# ── Step 3: Clone or pull repo ────────────────────────────────────────────────
if [[ -z "${REPO_URL}" ]]; then
  if [[ -f "${TARGET_DIR}/server.js" ]]; then
    info "No repo URL provided — using existing install at ${TARGET_DIR}."
    REPO_URL="skip"
  else
    error "REPO_URL is required for a fresh install."
    echo "  Usage: bash install-termux.sh <repo-url> <pairing-token> [target-dir]"
    exit 1
  fi
fi

if [[ "${REPO_URL}" != "skip" ]]; then
  if [[ -d "${TARGET_DIR}/.git" ]]; then
    info "Existing repo found — pulling latest..."
    git -C "${TARGET_DIR}" pull --rebase
  else
    info "Cloning engine into ${TARGET_DIR}..."
    git clone "${REPO_URL}" "${TARGET_DIR}"
  fi
fi

# ── Step 4: Pairing token (auto-generated once, stored in engine-state.json) ──
STATE_FILE="${TARGET_DIR}/engine-state.json"

if [[ ! -f "${STATE_FILE}" ]] || ! grep -q '"token"' "${STATE_FILE}" 2>/dev/null; then
  if [[ -z "${PAIRING_TOKEN}" ]]; then
    PAIRING_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  fi
  echo "{\"token\":\"${PAIRING_TOKEN}\"}" > "${STATE_FILE}"
  echo ""
  echo -e "  ${BOLD}Pairing token:${RESET} ${CYAN}${PAIRING_TOKEN}${RESET}"
  echo -e "  ${YELLOW}Enter this in the Android app's pairing screen — it will not be shown again.${RESET}"
  echo ""
else
  success "Pairing token already set."
fi


# ── Step 5: Install npm dependencies ─────────────────────────────────────────
info "Installing npm dependencies..."
npm --prefix "${TARGET_DIR}" install --omit=dev

# ── Step 6: Register with termux-services (auto-restart on boot/crash) ────────
SERVICE_DIR="${HOME}/.termux/service/idan-engine"
RUN_SCRIPT="${TARGET_DIR}/service/run"

if command -v sv &>/dev/null && [[ -f "${RUN_SCRIPT}" ]]; then
  info "Registering idan-engine with termux-services..."
  mkdir -p "${SERVICE_DIR}"

  # Symlink the run/finish scripts
  ln -sf "${RUN_SCRIPT}" "${SERVICE_DIR}/run"
  if [[ -f "${TARGET_DIR}/service/finish" ]]; then
    ln -sf "${TARGET_DIR}/service/finish" "${SERVICE_DIR}/finish"
  fi

  chmod +x "${SERVICE_DIR}/run"
  sv-enable idan-engine 2>/dev/null || true
  sv up idan-engine     2>/dev/null || true
  success "Service registered with termux-services. It will auto-start on every Termux boot."
else
  # Fallback: simple background process
  warn "termux-services not found or service/run missing — starting engine in background..."
  pkill -f "node.*server.js" 2>/dev/null || true
  sleep 1
  nohup node "${TARGET_DIR}/server.js" >> "${TARGET_DIR}/engine.log" 2>&1 &
  ENGINE_PID=$!
  success "Engine started in background (PID ${ENGINE_PID}). Not persistent across reboots."
  warn "For auto-restart, install termux-services: pkg install termux-services"
fi

# ── Step 7: Health check ──────────────────────────────────────────────────────
info "Waiting for engine to start..."
sleep 3

ENGINE_PORT="${IDAN_ENGINE_PORT:-3788}"

if curl -sf "http://127.0.0.1:${ENGINE_PORT}/health" > /dev/null 2>&1; then
  success "Engine is UP on port ${ENGINE_PORT} ✓"
  HEALTH="$(curl -s "http://127.0.0.1:${ENGINE_PORT}/health")"
  echo -e "  ${HEALTH}"
else
  warn "Engine health check failed. Check logs: tail -f ${TARGET_DIR}/engine.log"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Installation complete!${RESET}"
echo ""
echo -e "  ${BOLD}Engine dir:${RESET}  ${TARGET_DIR}"
echo -e "  ${BOLD}Logs:${RESET}        tail -f ${TARGET_DIR}/engine.log"
echo -e "  ${BOLD}Update:${RESET}      bash ${TARGET_DIR}/update.sh"
echo -e "  ${BOLD}Health:${RESET}      curl http://127.0.0.1:${ENGINE_PORT}/health"
echo ""
