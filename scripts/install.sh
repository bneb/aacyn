#!/bin/sh
# install.sh — aacyn bare-metal/VM install. Idempotent; re-run to upgrade.
set -eu

# ── Platform ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
[ "${OS}" != "Linux" ] && echo "aacyn: Linux only (detected: ${OS})" && exit 1
case "${ARCH}" in x86_64|amd64) ARCH="x86_64" ;; aarch64|arm64) ARCH="arm64" ;;
  *) echo "aacyn: unsupported arch: ${ARCH}"; exit 1 ;; esac

# ── Download & extract ──────────────────────────────────────────────────────
TMP="/tmp/aacyn-install-$$"
TAR="aacyn-linux-${ARCH}.tar.gz"
URL="https://github.com/bneb/aacyn/releases/latest/download/${TAR}"
printf "aacyn: downloading %s ...\n" "${TAR}"
mkdir -p "${TMP}"
curl -sfL "${URL}" -o "${TMP}/${TAR}"
tar -xzf "${TMP}/${TAR}" -C "${TMP}"
D="${TMP}/aacyn-linux-${ARCH}"

# ── Install binaries ────────────────────────────────────────────────────────
mkdir -p /usr/local/lib/aacyn /usr/local/bin /etc/aacyn
mv "${D}/bin/bun" /usr/local/lib/aacyn/bun
chmod 755 /usr/local/lib/aacyn/bun
for f in "${D}/lib/"*; do [ -f "${f}" ] && mv "${f}" /usr/local/lib/; done
if [ -d "${D}/server" ]; then
  rm -rf /usr/local/lib/aacyn/server
  mv "${D}/server" /usr/local/lib/aacyn/server
fi

# ── aacyn wrapper ───────────────────────────────────────────────────────────
cat > /usr/local/bin/aacyn << 'WRAP'
#!/bin/sh
exec /usr/local/lib/aacyn/bun run /usr/local/lib/aacyn/server/src/index.ts "$@"
WRAP
chmod 755 /usr/local/bin/aacyn

# ── Config (preserve on upgrade) ────────────────────────────────────────────
if [ ! -f /etc/aacyn/aacyn.toml ]; then
  cat > /etc/aacyn/aacyn.toml << 'CONFIG'
listen = "0.0.0.0:3001"
store_size = 1000000
[[filters]]
column = "duration"
op = "lt"
threshold = 1.0
action = "drop"
CONFIG
  echo "aacyn: created /etc/aacyn/aacyn.toml"
fi

# ── systemd unit ────────────────────────────────────────────────────────────
cat > /etc/systemd/system/aacyn.service << 'UNIT'
[Unit]
Description=aacyn - eBPF observability engine
Documentation=https://github.com/bneb/aacyn
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/bin/aacyn
Restart=on-failure
RestartSec=5
Environment=LIBAACYN_PATH=/usr/local/lib/libaacyn.so
Environment=AACYN_MODE=standalone
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT

# ── Enable & start ──────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable aacyn
systemctl restart aacyn
rm -rf "${TMP}"

# ── Success ─────────────────────────────────────────────────────────────────
echo ""
echo "aacyn is running! Dashboard at http://localhost:3001/dashboard"
