#!/usr/bin/env bash
# =============================================================================
# update.sh — pull the latest engine code and restart the service
#
# Run from anywhere:
#   bash ~/idan-engine/update.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${SCRIPT_DIR}/engine.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[idan]${RESET} $*"; }
success() { echo -e "${GREEN}[idan]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[idan]${RESET} $*"; }

echo -e ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   idan-engine  —  Updater    ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════╝${RESET}"
echo -e ""

# ── Pull latest code ──────────────────────────────────────────────────────────
if [[ -d "${SCRIPT_DIR}/.git" ]]; then
  info "Pulling latest from remote..."
  # Termux creates local runtime edits (market data, package-lock changes,
  # native build scripts). Preserve tracked edits while still allowing the
  # updater to receive the latest engine code.
  if ! git -C "${SCRIPT_DIR}" pull --rebase --autostash; then
    warn "Git update could not be applied; keeping the current engine code."
  fi
  success "Code updated."
else
  warn "No .git directory found at ${SCRIPT_DIR} — skipping git pull."
fi

# ── Ensure new runtime prerequisites are installed automatically ──────────────
if command -v pkg &>/dev/null; then
  info "Checking Termux runtime packages..."
  pkg update -y >/dev/null 2>&1 || true
  pkg install -y git nodejs-lts curl golang clang termux-services termux-api android-tools >/dev/null
  success "Termux runtime packages are ready."
fi

# ── Re-install dependencies (in case package.json changed) ───────────────────
info "Checking npm dependencies..."
npm --prefix "${SCRIPT_DIR}" install --omit=dev
success "Dependencies up to date."

# ── Keep native capabilities aligned with the checked-out code ───────────────
if command -v go &>/dev/null && [[ -f "${SCRIPT_DIR}/build-whatsapp-sidecar.sh" ]]; then
  info "Rebuilding the WhatsApp whatsmeow sidecar..."
  chmod +x "${SCRIPT_DIR}/build-whatsapp-sidecar.sh"
  if bash "${SCRIPT_DIR}/build-whatsapp-sidecar.sh"; then
    success "WhatsApp whatsmeow sidecar updated."
  else
    warn "Whatsmeow rebuild failed; keeping the previous sidecar if one exists."
  fi
else
  warn "Go is not available; skipping Whatsmeow rebuild. The next install/update will retry it."
fi

if ! command -v sv &>/dev/null; then
  warn "termux-services is not available; the engine can run, but automatic restart is disabled."
fi

# ── Restart service ───────────────────────────────────────────────────────────
if command -v sv &>/dev/null; then
  info "Restarting via termux-services..."
  sv restart idan-engine
  success "Service restarted."
else
  info "termux-services not found — using process restart..."
  pkill -f "node.*server.js" 2>/dev/null && info "Stopped old process." || true
  sleep 1
  nohup node "${SCRIPT_DIR}/server.js" >> "${LOG}" 2>&1 &
  success "Engine restarted in background (PID $!)."
fi

# ── Health check ──────────────────────────────────────────────────────────────
sleep 3
ENV_FILE="${SCRIPT_DIR}/.env"
ENGINE_PORT="$(grep -m1 'IDAN_ENGINE_PORT' "${ENV_FILE}" 2>/dev/null | cut -d= -f2 || echo 3788)"
ENGINE_PORT="${ENGINE_PORT:-3788}"

if curl -sf "http://127.0.0.1:${ENGINE_PORT}/health" > /dev/null 2>&1; then
  success "Engine is UP on port ${ENGINE_PORT} ✓"
else
  warn "Health check failed. Check logs: tail -f ${LOG}"
fi

echo ""
