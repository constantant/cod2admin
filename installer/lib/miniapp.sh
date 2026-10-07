# shellcheck shell=sh
# The Telegram Mini App's HTTPS step (docs/PLAN-miniapp.md §3), sourced by install.sh. POSIX sh,
# like the rest of the installer.
#
# Telegram only opens a Mini App over HTTPS with a publicly trusted certificate. The gateway
# serves the app on a loopback port (MINIAPP_PORT); in front of it this sets up Caddy, which gets
# a Let's Encrypt certificate by itself. The hostname is the admin's own domain if they have one,
# else <ip-with-dashes>.sslip.io, a free wildcard DNS name that points at this server's IP — so no
# domain or DNS work is needed. Three cases where this steps aside instead:
#   - ports 80/443 are already in use (an existing nginx/Apache): prints the reverse-proxy rule to
#     add there;
#   - the server has no public IP (home NAT): points at the Cloudflare Tunnel guide in
#     installer/README.md;
#   - MINIAPP_URL is given in the --config file: the admin handles HTTPS themselves.
#
# Sets MINIAPP_PORT and MINIAPP_URL for write_env (both empty = Mini App off).

MINIAPP_PORT=""
MINIAPP_URL=""
MINIAPP_DEFAULT_PORT=18090
CADDY_DIR="/etc/caddy"
CADDY_SITE_FILE="$CADDY_DIR/cod2admin.caddy"

write_miniapp_helper_scripts() {
  # Prints this server's public IPv4 as the internet sees it, or nothing.
  cat > "$TMP_DIR/public-ip.mjs" <<'EOF'
const services = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip'];
for (const url of services) {
  try {
    const text = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
      console.log(text);
      process.exit(0);
    }
  } catch {}
}
process.exit(1);
EOF
  # Exit 0 if every port given can be listened on right now (i.e. nothing else holds it).
  cat > "$TMP_DIR/ports-free.mjs" <<'EOF'
import net from 'node:net';
for (const port of process.argv.slice(2).map(Number)) {
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
  if (!free) process.exit(1);
}
EOF
  # Exit 0 once https://$1/ answers (Caddy can take a minute to get the certificate).
  cat > "$TMP_DIR/https-check.mjs" <<'EOF'
const url = `https://${process.argv[2]}/`;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
process.exit(1);
EOF
}

# 10.x, 172.16-31.x, 192.168.x, 100.64-127.x (CGNAT), 127.x - not reachable from the internet.
is_private_ipv4() {
  case $1 in
    10.*|127.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

# The IP this host's outgoing traffic leaves from, per its routing table - compared with the
# public IP to tell a directly reachable server from one behind NAT.
local_route_ip() {
  ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1
}

wizard_miniapp() {
  step "Telegram Mini App (optional)"
  info "A full-screen server manager that opens inside Telegram: players, chat, maps, bans."
  info "Telegram needs HTTPS for it, so this sets up Caddy (a small web server that gets its own"
  info "certificate) on ports 80 and 443. The chat commands work the same either way."

  _domain=""
  if [ -n "$CONFIG_FILE" ]; then
    config_get MINIAPP_URL; MINIAPP_URL=$CONFIG_VALUE
    config_get MINIAPP_PORT; MINIAPP_PORT=${CONFIG_VALUE:-$MINIAPP_DEFAULT_PORT}
    config_get MINIAPP_DOMAIN; _domain=$CONFIG_VALUE
    config_get MINIAPP_ENABLED
    if [ -n "$MINIAPP_URL" ]; then
      success "Using MINIAPP_URL=$MINIAPP_URL from the config file - HTTPS for it is up to you."
      return 0
    fi
    case $CONFIG_VALUE in
      true|yes|1) ;;
      *) MINIAPP_PORT=""; info "Skipped (set MINIAPP_ENABLED=true in the config file to turn it on)."; return 0 ;;
    esac
  else
    if ! ask_yes_no "Turn on the Mini App" y; then
      info "Skipped. Re-run install.sh any time to turn it on."
      return 0
    fi
    MINIAPP_PORT=$MINIAPP_DEFAULT_PORT
    info "If this server has a domain name pointing at it, enter it. Otherwise leave blank and"
    info "a free <your-ip>.sslip.io name is used - no domain or DNS setup needed."
    ask "Domain for the Mini App (optional)" ""
    _domain=$REPLY_VALUE
  fi

  write_miniapp_helper_scripts

  if [ -z "$_domain" ]; then
    info "Finding this server's public IP..."
    _public_ip=$(node "$TMP_DIR/public-ip.mjs" 2>/dev/null || true)
    if [ -z "$_public_ip" ]; then
      warn "Couldn't find this server's public IP. Re-run with a domain, or see installer/README.md (Mini App)."
      MINIAPP_PORT=""
      return 0
    fi
    _route_ip=$(local_route_ip)
    if [ -n "$_route_ip" ] && [ "$_route_ip" != "$_public_ip" ] && is_private_ipv4 "$_route_ip"; then
      warn "This server is behind NAT (its address is $_route_ip, the internet sees $_public_ip),"
      warn "so Telegram can't reach it directly. Follow \"Mini App behind NAT\" in installer/README.md"
      warn "(a free Cloudflare Tunnel), then put the tunnel's URL in MINIAPP_URL in $INSTALL_DIR/.env."
      info "The Mini App server still starts on 127.0.0.1:$MINIAPP_PORT for the tunnel to use."
      return 0
    fi
    _domain="$(printf '%s' "$_public_ip" | tr '.' '-').sslip.io"
    success "Using $_domain (points at $_public_ip)."
  fi

  MINIAPP_URL="https://$_domain"
  setup_caddy "$_domain"
}

setup_caddy() {
  _host=$1

  if ! command -v caddy >/dev/null 2>&1 && ! node "$TMP_DIR/ports-free.mjs" 80 443; then
    warn "Something else already uses port 80 or 443 (nginx, Apache...), so Caddy isn't installed."
    print_proxy_instructions "$_host"
    return 0
  fi

  if ! command -v caddy >/dev/null 2>&1; then
    info "Installing Caddy..."
    pkg_update >/dev/null 2>&1 || true
    if ! pkg_install caddy >/dev/null 2>&1; then
      warn "Caddy isn't in this system's packages (it is on Debian 12+, Ubuntu 22.04+ and Alpine)."
      warn "Install it from https://caddyserver.com/docs/install, then re-run install.sh."
      print_proxy_instructions "$_host"
      return 0
    fi
  fi

  mkdir -p "$CADDY_DIR"
  cat > "$CADDY_SITE_FILE" <<EOF
# Written by the cod2admin installer - the Telegram Mini App (docs/PLAN-miniapp.md).
$_host {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$MINIAPP_PORT
}
EOF
  # Our site lives in its own file. A Caddyfile that's still the package's placeholder page is
  # replaced; one with the admin's own sites keeps them and just imports ours.
  _caddyfile="$CADDY_DIR/Caddyfile"
  if [ ! -s "$_caddyfile" ] || grep -q '/usr/share/caddy' "$_caddyfile"; then
    printf 'import %s\n' "$CADDY_SITE_FILE" > "$_caddyfile"
  elif ! grep -qF "import $CADDY_SITE_FILE" "$_caddyfile"; then
    printf '\nimport %s\n' "$CADDY_SITE_FILE" >> "$_caddyfile"
  fi
  caddy validate --config "$_caddyfile" --adapter caddyfile >/dev/null 2>&1 || \
    { warn "Caddy rejected $_caddyfile - check it by hand: caddy validate --config $_caddyfile"; return 0; }

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && info "Opened ports 80 and 443 in ufw."
  fi

  # Not fatal: the bot itself is fine without the Mini App.
  _started=0
  detect_init_system
  case $INIT_SYSTEM in
    systemd) systemctl enable caddy >/dev/null 2>&1 || true; systemctl reload-or-restart caddy && _started=1 ;;
    openrc)  rc-update add caddy default >/dev/null 2>&1 || true; rc-service caddy restart >/dev/null && _started=1 ;;
    none)
      caddy stop >/dev/null 2>&1 || true
      caddy start --config "$_caddyfile" --adapter caddyfile >/dev/null 2>&1 && _started=1 ;;
  esac
  if [ "$_started" -ne 1 ]; then
    warn "Caddy didn't start - see its log. The Mini App needs it; the bot itself works without."
    return 0
  fi
  success "Caddy serves https://$_host and forwards it to the bot."
  info "If a firewall outside this server (your host's control panel) blocks ports 80/443, open them."
}

print_proxy_instructions() {
  info "To serve the Mini App through your existing web server, proxy https://$1 to"
  info "http://127.0.0.1:$MINIAPP_PORT, with WebSocket upgrades allowed for /api/ws. For nginx:"
  info "  location / { proxy_pass http://127.0.0.1:$MINIAPP_PORT; proxy_http_version 1.1;"
  info "    proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection upgrade; }"
}

# After the bot started: checks the Mini App answers over HTTPS. Warns only - the bot is fine
# without it, and a certificate can take a few minutes on a busy day.
verify_miniapp() {
  [ -n "$MINIAPP_URL" ] && [ -f "$CADDY_SITE_FILE" ] || return 0
  _host=${MINIAPP_URL#https://}
  info "Checking $MINIAPP_URL (getting the certificate can take a minute)..."
  if node "$TMP_DIR/https-check.mjs" "$_host"; then
    success "Mini App is live at $MINIAPP_URL - open it from the bot's menu button in Telegram."
  else
    warn "$MINIAPP_URL didn't answer yet. Check that ports 80 and 443 are open to the internet;"
    warn "Caddy keeps retrying the certificate. Its log: journalctl -u caddy (or caddy's own output)."
  fi
}
