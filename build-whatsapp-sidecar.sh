#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/bin"
mkdir -p "$OUT"
cd "$ROOT/go/whatsapp-sidecar"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) NAME="idan-whatsapp-sidecar-android-arm64" ;;
  armv7l|armv8l) NAME="idan-whatsapp-sidecar-android-arm" ;;
  x86_64|amd64) NAME="idan-whatsapp-sidecar-android-amd64" ;;
  *) echo "Unsupported Termux architecture: $ARCH" >&2; exit 1 ;;
esac

CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o "$OUT/$NAME" .
chmod 700 "$OUT/$NAME"
echo "Built $OUT/$NAME"
