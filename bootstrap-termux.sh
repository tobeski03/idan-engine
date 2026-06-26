#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
PAIRING_TOKEN="${2:-}"
TARGET_DIR="${3:-idan-engine}"

if [[ -z "${REPO_URL}" || -z "${PAIRING_TOKEN}" ]]; then
  echo "Usage: bootstrap-termux.sh <repo-url> <pairing-token> [target-dir]"
  exit 1
fi

pkg update -y
pkg install -y git nodejs-lts

# Ensure curl is installed for downloading packages
if ! command -v curl &> /dev/null; then
  echo "Installing curl..."
  pkg install -y curl
fi

# Ensure termux-api CLI package is installed inside Termux
if ! command -v termux-battery-status &> /dev/null; then
  echo "Installing termux-api CLI package..."
  pkg install -y termux-api
fi

# Check if the Termux:API companion Android app is installed on the phone
if ! pm list packages | grep -q "package:com.termux.api"; then
  echo "--------------------------------------------------------"
  echo "Termux:API companion app is not installed on your Android device."
  echo "This is required to control flashlight, volume, Wi-Fi, etc."
  echo "--------------------------------------------------------"
  
  # Try to detect if Termux was installed via F-Droid to match signatures
  if pm list packages -i | grep -q "com.termux.*fdroid"; then
    echo "Detected Termux was installed via F-Droid. Downloading F-Droid-signed Termux:API..."
    APK_URL="https://f-droid.org/repo/com.termux.api_51.apk"
  else
    echo "Downloading GitHub-signed Termux:API..."
    APK_URL="https://github.com/termux/termux-api/releases/download/v0.50.1/termux-api_v0.50.1+github-debug.apk"
  fi

  echo "Downloading: ${APK_URL}"
  curl -L -o termux-api.apk "${APK_URL}"

  echo "Launching Android Package Installer to install Termux:API..."
  echo "IMPORTANT: If you get a 'Blocked by Play Protect' warning:"
  echo "1. Tap 'More details' or 'Details'."
  echo "2. Tap 'Install anyway'."
  echo "If it fails with a 'Package conflict' or signature mismatch, you must install Termux:API from the SAME source as your Termux app."
  
  if command -v termux-open &> /dev/null; then
    termux-open termux-api.apk
  else
    am start -a android.intent.action.VIEW -d "file://$(pwd)/termux-api.apk" -t "application/vnd.android.package-archive" || echo "Please install termux-api.apk manually."
  fi
fi

if [[ -d "${TARGET_DIR}/.git" ]]; then
  cd "${TARGET_DIR}"
  git pull --rebase
else
  git clone "${REPO_URL}" "${TARGET_DIR}"
  cd "${TARGET_DIR}"
fi

node bootstrap.js "${REPO_URL}" "${PAIRING_TOKEN}" "${TARGET_DIR}"
npm run start
