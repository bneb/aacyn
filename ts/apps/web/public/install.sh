#!/bin/sh
# aacyn installer — https://aacyn.com
#
# Usage:
#   curl -sSL https://aacyn.com/install.sh | bash
#   curl -sSL https://aacyn.com/install.sh | bash -s -- --version v0.7.0
#
# Installs pre-built aacyn binaries to /usr/local/lib/aacyn
# and the CLI wrapper to /usr/local/bin/aacyn.

set -eu

REPO="bneb/aacyn-releases"
INSTALL_DIR="/usr/local/lib/aacyn"
BIN_DIR="/usr/local/bin"
VERSION="${1:-latest}"

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${CYAN}▸${RESET} %s\n" "$1"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

# ── Platform Detection ────────────────────────────────────────────────────────

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux)  PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *)      fail "Unsupported OS: $OS. aacyn requires Linux or macOS." ;;
esac

case "$ARCH" in
  x86_64|amd64)   ARCH="x86_64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)               fail "Unsupported architecture: $ARCH" ;;
esac

TARBALL="aacyn-${PLATFORM}-${ARCH}.tar.gz"

# ── Resolve Version ──────────────────────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
  info "Resolving latest version..."
  VERSION=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$VERSION" ]; then
    fail "Could not determine latest version. Pass --version explicitly."
  fi
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

# ── Banner ────────────────────────────────────────────────────────────────────

printf "\n"
printf "${BOLD}  ╔══════════════════════════════════════════╗${RESET}\n"
printf "${BOLD}  ║  ${CYAN}aacyn${RESET}${BOLD} installer                        ║${RESET}\n"
printf "${BOLD}  ║  5M events/sec observability engine      ║${RESET}\n"
printf "${BOLD}  ╚══════════════════════════════════════════╝${RESET}\n"
printf "\n"
info "Platform:  ${PLATFORM}/${ARCH}"
info "Version:   ${VERSION}"
info "Tarball:   ${TARBALL}"
printf "\n"

# ── Download ──────────────────────────────────────────────────────────────────

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading ${DOWNLOAD_URL}..."
HTTP_CODE=$(curl -sSL -w '%{http_code}' -o "${TMPDIR}/${TARBALL}" "$DOWNLOAD_URL")

if [ "$HTTP_CODE" != "200" ]; then
  fail "Download failed (HTTP ${HTTP_CODE}). Check that version ${VERSION} exists at:
  ${DOWNLOAD_URL}"
fi
ok "Downloaded ${TARBALL}"

# ── Extract ───────────────────────────────────────────────────────────────────

info "Extracting to ${INSTALL_DIR}..."

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  info "Requesting sudo for /usr/local installation..."
else
  SUDO=""
fi

$SUDO mkdir -p "$INSTALL_DIR"
$SUDO tar -xzf "${TMPDIR}/${TARBALL}" -C "$INSTALL_DIR" --strip-components=1
ok "Extracted to ${INSTALL_DIR}"

# ── Install CLI Wrapper ──────────────────────────────────────────────────────

$SUDO tee "$BIN_DIR/aacyn" > /dev/null << 'WRAPPER'
#!/bin/sh
# aacyn CLI wrapper — delegates to the Bun API server
AACYN_HOME="${AACYN_HOME:-/usr/local/lib/aacyn}"
exec "${AACYN_HOME}/bin/bun" run "${AACYN_HOME}/server/src/index.ts" "$@"
WRAPPER
$SUDO chmod +x "$BIN_DIR/aacyn"
ok "Installed CLI to ${BIN_DIR}/aacyn"

# ── Verify ────────────────────────────────────────────────────────────────────

if [ -f "${INSTALL_DIR}/lib/libaacyn.so" ] || [ -f "${INSTALL_DIR}/lib/libaacyn.dylib" ]; then
  ok "Native library verified"
else
  info "Native library not found — will use V8 Map fallback"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

printf "\n"
printf "${GREEN}${BOLD}  aacyn ${VERSION} installed successfully!${RESET}\n"
printf "\n"
printf "  ${BOLD}Quick start:${RESET}\n"
printf "    ${CYAN}aacyn${RESET}                           Start the aacyn server\n"
printf "    ${CYAN}curl -X POST localhost:3001/ingest${RESET}  Send events\n"
printf "    ${CYAN}curl localhost:3001/query${RESET}           Query the store\n"
printf "\n"
printf "  ${BOLD}With OTLP (any OpenTelemetry SDK):${RESET}\n"
printf "    ${CYAN}export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3001${RESET}\n"
printf "\n"
printf "  ${BOLD}Documentation:${RESET} https://aacyn.com/docs\n"
printf "\n"
