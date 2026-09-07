#!/bin/sh
# cod2admin installer — installs the Telegram/RCON admin bot on THIS host, alongside a CoD2
# dedicated server that is already installed and already running here. Does not touch the game
# server in any way (no files written under its install, no config changes) — only needs its
# RCON host/port/password and its games_mp.log path.
#
# POSIX sh on purpose (not bash): the most common install targets are minimal Debian/Ubuntu boxes
# and Alpine-based containers, and Alpine's default userland has no bash at all.
#
# Usage:
#   sudo ./install.sh                  interactive wizard (recommended)
#   sudo ./install.sh --config FILE    non-interactive, answers read from FILE (KEY=VALUE lines)
#   ./install.sh --help

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR="/opt/cod2admin"
CONFIG_FILE=""
NODE_MIN_MAJOR=20

# ── Shared helpers (output helpers, init-system detection, service restart/verify, pruning) ────
# See installer/lib/service.sh - also sourced by apply-update.sh from its own installed location.
# shellcheck source=lib/service.sh
. "$SCRIPT_DIR/lib/service.sh"

# Layout (docs/PLAN.md §13.5): $INSTALL_DIR itself is stable and never swapped. Each
# install/update lands in its own $RELEASES_DIR/<version>, and $CURRENT_LINK always points at
# whichever one is live - the systemd unit/OpenRC script/fallback start.sh all run out of
# $CURRENT_LINK, so applying an update (apply-update.sh) never has to touch them, only the
# symlink. Set below, once INSTALL_DIR is final (after --install-dir parsing).
RELEASES_DIR=""
CURRENT_LINK=""
BIN_DIR=""
STAGING_DIR=""
set_layout_paths() {
  RELEASES_DIR="$INSTALL_DIR/releases"
  CURRENT_LINK="$INSTALL_DIR/current"
  BIN_DIR="$INSTALL_DIR/bin"
  STAGING_DIR="$INSTALL_DIR/staging"
}
set_layout_paths

# Prints "$1" as a prompt (with optional default shown), reads a line into $REPLY_VALUE.
ask() {
  _prompt=$1; _default=${2:-}
  if [ -n "$_default" ]; then
    printf '%s%s%s [%s]: ' "$C_BOLD" "$_prompt" "$C_RESET" "$_default"
  else
    printf '%s%s%s: ' "$C_BOLD" "$_prompt" "$C_RESET"
  fi
  IFS= read -r REPLY_VALUE || REPLY_VALUE=""
  if [ -z "$REPLY_VALUE" ] && [ -n "$_default" ]; then
    REPLY_VALUE=$_default
  fi
}

# Same as ask(), but hides input (for secrets already known, rarely needed since we generate ours).
ask_secret() {
  _prompt=$1
  printf '%s%s%s: ' "$C_BOLD" "$_prompt" "$C_RESET"
  if command -v stty >/dev/null 2>&1; then
    stty -echo 2>/dev/null || true
    IFS= read -r REPLY_VALUE || REPLY_VALUE=""
    stty echo 2>/dev/null || true
    printf '\n'
  else
    IFS= read -r REPLY_VALUE || REPLY_VALUE=""
  fi
}

ask_yes_no() {
  _prompt=$1; _default=${2:-y}
  while true; do
    ask "$_prompt (y/n)" "$_default"
    case $REPLY_VALUE in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) info "Please answer y or n." ;;
    esac
  done
}

# ── Argument parsing ─────────────────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case $1 in
    --config)
      CONFIG_FILE=$2; shift 2 ;;
    --install-dir)
      INSTALL_DIR=$2; shift 2 ;;
    -h|--help)
      cat <<'EOF'
cod2admin installer

  sudo ./install.sh                  interactive wizard (recommended)
  sudo ./install.sh --config FILE    non-interactive install, answers from FILE
  sudo ./install.sh --install-dir /opt/cod2admin   override the install directory

FILE format for --config (KEY=VALUE, one per line):
  TELEGRAM_BOT_TOKEN=...
  OWNER_TELEGRAM_ID=...            (optional)
  COD2_SERVER_ALIAS=default        (optional)
  COD2_RCON_HOST=127.0.0.1
  COD2_RCON_PORT=28960
  COD2_RCON_PASSWORD=...
  COD2_LOG_PATH=/path/to/games_mp.log   (optional)
  DB_MODE=local|external
  DATABASE_URL=...                 (required if DB_MODE=external)
EOF
      exit 0 ;;
    *)
      die "Unknown argument: $1 (see --help)" ;;
  esac
done

# --install-dir, if given, is only known once the loop above finishes.
set_layout_paths

if [ -n "$CONFIG_FILE" ]; then
  [ -f "$CONFIG_FILE" ] || die "--config file not found: $CONFIG_FILE"
fi

# Reads KEY from $CONFIG_FILE (non-interactive mode only) into $CONFIG_VALUE, empty if absent.
config_get() {
  CONFIG_VALUE=$(grep -E "^$1=" "$CONFIG_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true)
}

# ── Root check ───────────────────────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  die "This installer needs root (it installs system packages and a service). Re-run with sudo."
fi

# ── OS / package manager detection ──────────────────────────────────────────────────────────

PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v apk >/dev/null 2>&1; then
  PKG_MANAGER="apk"
else
  die "No supported package manager found (looked for apt-get, apk). This installer currently supports Debian/Ubuntu and Alpine hosts."
fi

pkg_install() {
  case $PKG_MANAGER in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    apk) apk add --no-cache "$@" ;;
  esac
}

pkg_update() {
  case $PKG_MANAGER in
    apt) apt-get update -y ;;
    apk) apk update ;;
  esac
}

# ── Node.js ──────────────────────────────────────────────────────────────────────────────────

ensure_node() {
  step "Checking for Node.js"
  if command -v node >/dev/null 2>&1; then
    _major=$(node -e 'console.log(process.versions.node.split(".")[0])')
    if [ "$_major" -ge "$NODE_MIN_MAJOR" ]; then
      success "Node.js $(node -v) found."
      return
    fi
    warn "Node.js $(node -v) is older than required (>= $NODE_MIN_MAJOR). Installing a newer one."
  else
    info "Node.js not found. Installing it."
  fi

  case $PKG_MANAGER in
    apt)
      pkg_update
      pkg_install ca-certificates curl gnupg
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
      pkg_install nodejs
      ;;
    apk)
      pkg_update
      pkg_install nodejs npm
      ;;
  esac

  command -v node >/dev/null 2>&1 || die "Node.js installation failed."
  success "Node.js $(node -v) installed."
}

# Small helper scripts we need Node for; written to a temp dir cleaned up on exit.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

write_helper_scripts() {
  cat > "$TMP_DIR/rcon-probe.mjs" <<'EOF'
import dgram from 'node:dgram';
const [, , host, port] = process.argv;
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const socket = dgram.createSocket('udp4');
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 3000);
socket.on('message', (msg) => {
  clearTimeout(timer);
  const ok = msg.length >= 4 && msg.subarray(0, 4).equals(OOB) && msg.subarray(4).toString('binary').startsWith('infoResponse');
  process.stdout.write(ok ? 'ok\n' : 'bad-response\n');
  socket.close();
  process.exit(ok ? 0 : 1);
});
socket.on('error', (err) => { console.error(err.message); process.exit(1); });
socket.send(Buffer.concat([OOB, Buffer.from('getinfo', 'binary')]), Number(port), host, (err) => {
  if (err) { console.error(err.message); process.exit(1); }
});
EOF

  cat > "$TMP_DIR/telegram-check.mjs" <<'EOF'
const token = process.argv[2];
try {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
  const body = await res.json();
  if (body.ok) {
    process.stdout.write(`ok ${body.result.username}\n`);
    process.exit(0);
  }
  console.error(body.description ?? 'Telegram API rejected the token');
  process.exit(1);
} catch (err) {
  console.error(err.message ?? String(err));
  process.exit(1);
}
EOF

  cat > "$TMP_DIR/db-check.mjs" <<'EOF'
import net from 'node:net';
const url = new URL(process.argv[2]);
const port = Number(url.port || 5432);
const socket = net.createConnection({ host: url.hostname, port, timeout: 4000 });
socket.on('connect', () => { socket.end(); process.exit(0); });
socket.on('timeout', () => { process.exit(1); });
socket.on('error', () => { process.exit(1); });
EOF

  cat > "$TMP_DIR/gen-secret.mjs" <<'EOF'
import { randomBytes } from 'node:crypto';
console.log(randomBytes(32).toString('base64'));
EOF

  cat > "$TMP_DIR/gen-hex.mjs" <<'EOF'
import { randomBytes } from 'node:crypto';
console.log(randomBytes(16).toString('hex'));
EOF
}

# ── PostgreSQL ───────────────────────────────────────────────────────────────────────────────

PG_MODE=""       # local | external
DATABASE_URL=""
DB_NAME="cod2admin"
DB_USER="cod2admin"
DB_PASSWORD=""

pg_bin() {
  # Finds a Postgres binary that may be version-suffixed under /usr/lib/postgresql/<ver>/bin (Debian).
  _name=$1
  if command -v "$_name" >/dev/null 2>&1; then
    command -v "$_name"
    return
  fi
  for d in /usr/lib/postgresql/*/bin; do
    [ -x "$d/$_name" ] && { echo "$d/$_name"; return; }
  done
  return 1
}

start_postgres_service() {
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    for unit in postgresql postgresql.service; do
      if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
        systemctl enable --now "$unit" >/dev/null 2>&1 && return 0
      fi
    done
    return 1
  fi
  if [ -d /run/openrc ] && command -v rc-service >/dev/null 2>&1; then
    rc-update add postgresql default >/dev/null 2>&1 || true
    rc-service postgresql start >/dev/null 2>&1 && return 0
    return 1
  fi
  return 1
}

start_postgres_manual() {
  _pg_ctl=$(pg_bin pg_ctl) || die "pg_ctl not found after installing postgresql."
  _initdb=$(pg_bin initdb) || die "initdb not found after installing postgresql."
  _pgdata="/var/lib/postgresql/cod2admin-data"
  mkdir -p "$_pgdata"
  chown -R postgres:postgres "$_pgdata" 2>/dev/null || chown -R postgres "$_pgdata"
  if [ ! -f "$_pgdata/PG_VERSION" ]; then
    info "No init system detected (likely a container) — initializing Postgres manually at $_pgdata."
    su -s /bin/sh postgres -c "$_initdb -D '$_pgdata'" >/dev/null
  fi
  # Debian's postgresql package creates /run/postgresql via its own postinst/tmpfiles; Alpine's
  # apk package does not (nothing runs that hooks it up without OpenRC actually supervising it) —
  # without it, postgres fails to start ("could not create lock file .../.s.PGSQL.5432.lock").
  mkdir -p /run/postgresql
  chown postgres:postgres /run/postgresql 2>/dev/null || chown postgres /run/postgresql
  if ! su -s /bin/sh postgres -c "$_pg_ctl -D '$_pgdata' status" >/dev/null 2>&1; then
    su -s /bin/sh postgres -c "$_pg_ctl -D '$_pgdata' -l '$_pgdata/server.log' -o \"-h 127.0.0.1\" start" >/dev/null
  fi
  _pg_isready=$(pg_bin pg_isready) || _pg_isready=pg_isready
  _tries=0
  while ! su -s /bin/sh postgres -c "$_pg_isready -h 127.0.0.1 >/dev/null 2>&1"; do
    _tries=$((_tries + 1))
    [ "$_tries" -ge 30 ] && die "Postgres did not become ready within 30s (see $_pgdata/server.log)."
    sleep 1
  done
}

ensure_postgres_running() {
  command -v psql >/dev/null 2>&1 || pg_bin psql >/dev/null 2>&1 || {
    step "Installing PostgreSQL"
    pkg_update
    case $PKG_MANAGER in
      apt) pkg_install postgresql postgresql-contrib ;;
      apk) pkg_install postgresql16 postgresql16-contrib ;;
    esac
  }
  step "Starting PostgreSQL"
  if start_postgres_service; then
    success "PostgreSQL running (managed by the host's init system)."
  else
    start_postgres_manual
    success "PostgreSQL running (manually supervised — no systemd/OpenRC on this host)."
  fi
}

create_db_role() {
  DB_PASSWORD=$(node "$TMP_DIR/gen-hex.mjs")
  info "Creating database role and database (idempotent — safe to re-run)."
  su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -tc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1 || \
    su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'\""
  su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -c \"ALTER ROLE $DB_USER PASSWORD '$DB_PASSWORD'\""
  su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -tc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1 || \
    su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER\""
  DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME"
}

wizard_database() {
  step "Database"
  if [ -n "$CONFIG_FILE" ]; then
    config_get DB_MODE; PG_MODE=${CONFIG_VALUE:-local}
  else
    info "cod2admin needs a Postgres database to store admins, bans and audit history."
    if ask_yes_no "Install and manage a local Postgres for it" y; then PG_MODE=local; else PG_MODE=external; fi
  fi

  if [ "$PG_MODE" = "local" ]; then
    ensure_postgres_running
    create_db_role
  else
    if [ -n "$CONFIG_FILE" ]; then
      config_get DATABASE_URL; DATABASE_URL=$CONFIG_VALUE
      [ -n "$DATABASE_URL" ] || die "DB_MODE=external requires DATABASE_URL in the config file."
    else
      info "Enter the connection string for your existing Postgres, e.g.:"
      info "  postgres://user:password@host:5432/dbname"
      while true; do
        ask "DATABASE_URL" ""
        [ -z "$REPLY_VALUE" ] && { info "This is required."; continue; }
        if node "$TMP_DIR/db-check.mjs" "$REPLY_VALUE" >/dev/null 2>&1; then
          DATABASE_URL=$REPLY_VALUE
          success "Reached that host."
          break
        fi
        warn "Could not open a TCP connection to that host/port — double check it and try again."
      done
    fi
    if [ -n "$CONFIG_FILE" ]; then
      node "$TMP_DIR/db-check.mjs" "$DATABASE_URL" >/dev/null 2>&1 || die "Could not reach DATABASE_URL from the config file."
    fi
  fi
}

# ── App install ──────────────────────────────────────────────────────────────────────────────
# Layout (docs/PLAN.md §13.5): each install/reconfigure lands its bundle in its own
# $RELEASES_DIR/<version>, owned by root and only readable (not writable) by the cod2admin service
# user - it can run its own code but never modify it. $CURRENT_LINK is repointed at the new
# version; apply-update.sh (installed below by install_update_machinery) later does the same thing
# unattended, which is why nothing here is INSTALL_DIR-flat anymore.

install_app() {
  step "Installing cod2admin to $INSTALL_DIR"
  _tarball=$(ls "$SCRIPT_DIR"/cod2admin-gateway-*.tar.gz 2>/dev/null | head -n1) || true
  [ -n "${_tarball:-}" ] || die "Could not find cod2admin-gateway-*.tar.gz next to install.sh. Make sure you extracted the full installer bundle."
  _tarball_name=$(basename -- "$_tarball")
  _version=${_tarball_name#cod2admin-gateway-}
  _version=${_version%.tar.gz}

  if id cod2admin >/dev/null 2>&1; then
    :
  else
    case $PKG_MANAGER in
      apt) useradd --system --no-create-home --shell /usr/sbin/nologin cod2admin ;;
      apk) adduser -S -D -H -s /sbin/nologin cod2admin ;;
    esac
  fi

  mkdir -p "$INSTALL_DIR" "$RELEASES_DIR" "$BIN_DIR" "$STAGING_DIR"
  chown root:root "$INSTALL_DIR" "$BIN_DIR"

  _release_dir="$RELEASES_DIR/$_version"
  rm -rf "$_release_dir"
  mkdir -p "$_release_dir"
  tar -xzf "$_tarball" -C "$_release_dir" --strip-components=1
  chown -R root:root "$_release_dir"
  # Read/execute for everyone (cod2admin needs to run node against this), no write access for
  # anyone but root - the service can't modify its own code.
  chmod -R a+rX "$_release_dir"

  ln -sfn "releases/$_version" "$CURRENT_LINK"

  chown cod2admin "$STAGING_DIR"
  chmod 700 "$STAGING_DIR"

  prune_old_releases
  success "App files extracted (v$_version)."
}

install_update_machinery() {
  step "Installing update machinery"
  mkdir -p "$BIN_DIR/lib"
  cp "$SCRIPT_DIR/apply-update.sh" "$BIN_DIR/apply-update.sh"
  cp "$SCRIPT_DIR/lib/service.sh" "$BIN_DIR/lib/service.sh"
  chown -R root:root "$BIN_DIR"
  chmod 700 "$BIN_DIR/apply-update.sh"
  chmod 644 "$BIN_DIR/lib/service.sh"

  _sudoers_file=$(mktemp)
  cat > "$_sudoers_file" <<EOF
# Managed by cod2admin's installer - see docs/PLAN.md §13.4/§13.5. Re-run install.sh to update.
cod2admin ALL=(root) NOPASSWD: $BIN_DIR/apply-update.sh $STAGING_DIR/*
EOF
  if command -v visudo >/dev/null 2>&1; then
    visudo -cf "$_sudoers_file" >/dev/null || {
      rm -f "$_sudoers_file"
      die "Generated sudoers rule failed visudo validation - refusing to install it (this would break sudo system-wide). This is a bug in install.sh, please report it."
    }
  else
    warn "visudo not found - skipping syntax validation of the sudoers rule before installing it."
  fi
  cp "$_sudoers_file" /etc/sudoers.d/cod2admin
  chown root:root /etc/sudoers.d/cod2admin
  chmod 440 /etc/sudoers.d/cod2admin
  rm -f "$_sudoers_file"
  success "Installed apply-update.sh and its sudoers rule (the Telegram /update command that uses them ships in a later phase)."
}

# ── Config wizard ────────────────────────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN=""
OWNER_TELEGRAM_ID=""
COD2_SERVER_ALIAS="default"
COD2_RCON_HOST=""
COD2_RCON_PORT=""
COD2_RCON_PASSWORD=""
COD2_LOG_PATH=""
SECRETS_ENCRYPTION_KEY=""

wizard_telegram() {
  step "Telegram bot"
  if [ -n "$CONFIG_FILE" ]; then
    config_get TELEGRAM_BOT_TOKEN; TELEGRAM_BOT_TOKEN=$CONFIG_VALUE
    [ -n "$TELEGRAM_BOT_TOKEN" ] || die "TELEGRAM_BOT_TOKEN missing from config file."
    node "$TMP_DIR/telegram-check.mjs" "$TELEGRAM_BOT_TOKEN" >/dev/null || die "Telegram rejected TELEGRAM_BOT_TOKEN from the config file."
  else
    info "You'll need a bot token from @BotFather on Telegram (create a bot, it gives you a token)."
    while true; do
      ask "Telegram bot token" ""
      _out=$(node "$TMP_DIR/telegram-check.mjs" "$REPLY_VALUE" 2>&1) && { TELEGRAM_BOT_TOKEN=$REPLY_VALUE; success "Connected as @${_out#ok }"; break; }
      warn "Couldn't verify that token: $_out"
    done
  fi

  if [ -n "$CONFIG_FILE" ]; then
    config_get OWNER_TELEGRAM_ID; OWNER_TELEGRAM_ID=$CONFIG_VALUE
  else
    info "The 'owner' is the Telegram account with full control over the bot (add/remove admins, etc)."
    info "Leave blank to claim ownership yourself later by messaging the bot with /claim <secret>."
    ask "Your numeric Telegram user ID (optional)" ""
    OWNER_TELEGRAM_ID=$REPLY_VALUE
  fi
}

wizard_rcon() {
  step "CoD2 server connection (RCON)"
  info "This is the server this bot will manage — it must already be installed and running on"
  info "this host (or reachable from it). We only need its RCON details, nothing else changes on it."

  if [ -n "$CONFIG_FILE" ]; then
    config_get COD2_RCON_HOST; COD2_RCON_HOST=${CONFIG_VALUE:-127.0.0.1}
    config_get COD2_RCON_PORT; COD2_RCON_PORT=${CONFIG_VALUE:-28960}
    config_get COD2_RCON_PASSWORD; COD2_RCON_PASSWORD=$CONFIG_VALUE
    [ -n "$COD2_RCON_PASSWORD" ] || die "COD2_RCON_PASSWORD missing from config file."
    node "$TMP_DIR/rcon-probe.mjs" "$COD2_RCON_HOST" "$COD2_RCON_PORT" >/dev/null || \
      die "Could not reach a CoD2 server at $COD2_RCON_HOST:$COD2_RCON_PORT."
  else
    ask "CoD2 server RCON host" "127.0.0.1"; COD2_RCON_HOST=$REPLY_VALUE
    ask "CoD2 server RCON port" "28960"; COD2_RCON_PORT=$REPLY_VALUE
    info "Checking that a CoD2 server answers there..."
    if node "$TMP_DIR/rcon-probe.mjs" "$COD2_RCON_HOST" "$COD2_RCON_PORT" >/dev/null 2>&1; then
      success "Found a CoD2 server at $COD2_RCON_HOST:$COD2_RCON_PORT."
    else
      warn "No response from $COD2_RCON_HOST:$COD2_RCON_PORT — double check the server is running and the port/firewall are correct."
      ask_yes_no "Continue anyway" n || die "Aborted."
    fi
    info "This must match the rcon_password set in that server's server_mp.cfg."
    while true; do
      ask_secret "RCON password"
      [ -n "$REPLY_VALUE" ] && { COD2_RCON_PASSWORD=$REPLY_VALUE; break; }
      info "This is required."
    done
  fi
}

wizard_log_path() {
  step "Game event log"
  info "Needed for live match reports (!report), player join/leave tracking, etc."
  info "Leave blank to skip this for now — the bot still works for RCON commands without it."

  if [ -n "$CONFIG_FILE" ]; then
    config_get COD2_LOG_PATH; COD2_LOG_PATH=$CONFIG_VALUE
  else
    ask "Path to that server's games_mp.log (optional)" ""
    COD2_LOG_PATH=$REPLY_VALUE
  fi

  if [ -n "$COD2_LOG_PATH" ]; then
    if [ -r "$COD2_LOG_PATH" ]; then
      success "Found and readable: $COD2_LOG_PATH"
    else
      warn "$COD2_LOG_PATH is not readable from this host — the bot will fail to start log-based features until this is fixed."
      [ -n "$CONFIG_FILE" ] || ask_yes_no "Continue anyway" n || die "Aborted."
    fi
  fi
}

wizard_server_alias() {
  if [ -n "$CONFIG_FILE" ]; then
    config_get COD2_SERVER_ALIAS; COD2_SERVER_ALIAS=${CONFIG_VALUE:-default}
  else
    ask "A short name for this server (used in /bindserver etc.)" "default"
    COD2_SERVER_ALIAS=$REPLY_VALUE
  fi
}

generate_secrets() {
  SECRETS_ENCRYPTION_KEY=$(node "$TMP_DIR/gen-secret.mjs")
}

write_env() {
  step "Writing configuration"
  _env="$INSTALL_DIR/.env"
  {
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN"
    [ -n "$OWNER_TELEGRAM_ID" ] && printf 'OWNER_TELEGRAM_ID=%s\n' "$OWNER_TELEGRAM_ID"
    printf 'COD2_SERVER_ALIAS=%s\n' "$COD2_SERVER_ALIAS"
    printf 'COD2_RCON_HOST=%s\n' "$COD2_RCON_HOST"
    printf 'COD2_RCON_PORT=%s\n' "$COD2_RCON_PORT"
    printf 'COD2_RCON_PASSWORD=%s\n' "$COD2_RCON_PASSWORD"
    [ -n "$COD2_LOG_PATH" ] && printf 'COD2_LOG_PATH=%s\n' "$COD2_LOG_PATH"
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
    printf 'SECRETS_ENCRYPTION_KEY=%s\n' "$SECRETS_ENCRYPTION_KEY"
  } > "$_env"
  chown cod2admin "$_env"
  chmod 600 "$_env"
  success "Wrote $_env"
}

# ── Service registration ─────────────────────────────────────────────────────────────────────
# detect_init_system/restart_service/verify_running come from installer/lib/service.sh (sourced
# above) - shared with apply-update.sh, which reuses restart_service/verify_running to apply an
# update without ever touching the unit/init files this function writes.

register_service() {
  step "Registering the cod2admin service"
  detect_init_system
  _node=$(command -v node)

  case $INIT_SYSTEM in
    systemd)
      cat > /etc/systemd/system/cod2admin.service <<EOF
[Unit]
Description=cod2admin Telegram/RCON bot
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=cod2admin
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$_node $CURRENT_LINK/dist/main.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
      systemctl enable cod2admin >/dev/null
      ;;
    openrc)
      cat > /etc/init.d/cod2admin <<EOF
#!/sbin/openrc-run
name="cod2admin"
command="$_node"
command_args="$CURRENT_LINK/dist/main.js"
command_user="cod2admin"
directory="$CURRENT_LINK"
pidfile="/run/cod2admin.pid"
output_log="$INSTALL_DIR/cod2admin.log"
error_log="$INSTALL_DIR/cod2admin.log"

# Plain start-stop-daemon (the default supervisor) only starts the process - it doesn't notice or
# react if it later dies. supervise-daemon actively monitors the child and restarts it, giving
# OpenRC hosts the same crash-restart behavior as the systemd unit's Restart=on-failure above.
supervisor="supervise-daemon"
respawn_delay=3
respawn_max=0

start_pre() {
  set -a; . "$INSTALL_DIR/.env"; set +a
}
EOF
      chmod 755 /etc/init.d/cod2admin
      rc-update add cod2admin default >/dev/null 2>&1 || true
      ;;
    none)
      warn "No systemd or OpenRC detected (common inside minimal containers) — falling back to a"
      warn "background process. It will NOT automatically restart on crash or survive a reboot;"
      warn "set up your own supervision (e.g. your container's own restart policy) for production."
      cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/sh
set -a
. "$INSTALL_DIR/.env"
set +a
exec "$_node" "$CURRENT_LINK/dist/main.js"
EOF
      chown cod2admin "$INSTALL_DIR/start.sh"
      chmod 755 "$INSTALL_DIR/start.sh"
      ;;
  esac

  # restart, not "start"/"enable --now": on a reconfigure the service may already be running, and
  # a plain start is a no-op against an already-active unit — the new .env/version would never
  # load. restart_service (installer/lib/service.sh) is the same restart apply-update.sh uses.
  restart_service

  case $INIT_SYSTEM in
    systemd) success "Installed and started as a systemd service (cod2admin.service)." ;;
    openrc)  success "Installed and started as an OpenRC service (cod2admin)." ;;
    none)    success "Started in the background (logs: $INSTALL_DIR/cod2admin.log)." ;;
  esac
}

# ── Idempotency ──────────────────────────────────────────────────────────────────────────────

check_existing_install() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  [ -n "$CONFIG_FILE" ] && return 0

  step "Existing install found at $INSTALL_DIR"
  info "1) Reconfigure (keep files, ask questions again, restart the service)"
  info "2) Leave it alone and exit"
  ask "Choice" "2"
  case $REPLY_VALUE in
    1) return 0 ;;
    *) info "Nothing changed."; exit 0 ;;
  esac
}

# Detects the old flat layout (everything - dist/, node_modules/, .env - directly under
# $INSTALL_DIR, no versioned releases/current symlink, per pre-§13.5 install.sh) and moves it out
# of the way so install_app() below can build the new layout fresh. Doesn't bother preserving the
# old .env by hand - write_env() below always regenerates it in full from this run's wizard
# answers regardless (that was already true before this layout existed; re-running install.sh has
# never read back a prior .env). Admin/ban data lives in Postgres, untouched by any of this.
migrate_legacy_layout() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  [ -L "$CURRENT_LINK" ] && return 0

  step "Migrating to the versioned release layout"
  info "This install predates release directories/self-update support (docs/PLAN.md §13.5)."
  info "Rebuilding it fresh from this release's bundle - your Telegram/RCON details will be"
  info "re-asked below (or re-read from --config); admin/ban data in Postgres is untouched."

  detect_init_system
  case $INIT_SYSTEM in
    systemd) systemctl stop cod2admin >/dev/null 2>&1 || true ;;
    openrc)  rc-service cod2admin stop >/dev/null 2>&1 || true ;;
    none)
      _pidfile="$INSTALL_DIR/cod2admin.pid"
      if [ -f "$_pidfile" ] && kill -0 "$(cat "$_pidfile")" 2>/dev/null; then
        kill "$(cat "$_pidfile")" 2>/dev/null || true
      fi
      ;;
  esac

  _backup="${INSTALL_DIR}.pre-migration-backup"
  [ -e "$_backup" ] && die "$_backup already exists - refusing to overwrite it. Move or remove it by hand, then re-run install.sh."
  mv "$INSTALL_DIR" "$_backup"
  mkdir -p "$INSTALL_DIR"
  success "Moved the old install aside to $_backup (kept, not deleted)."
}

# ── Main ─────────────────────────────────────────────────────────────────────────────────────

main() {
  printf '%s%scod2admin installer%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
  info "This sets up the Telegram/RCON admin bot on this machine, next to an already-running"
  info "CoD2 dedicated server. It won't modify that server in any way."

  check_existing_install
  migrate_legacy_layout
  ensure_node
  write_helper_scripts
  wizard_database
  install_app
  install_update_machinery
  wizard_telegram
  wizard_rcon
  wizard_log_path
  wizard_server_alias
  generate_secrets
  write_env
  register_service
  step "Verifying"
  verify_running || die "cod2admin failed to start after install. See the output above for details."

  step "Done"
  success "cod2admin is installed and running."
}

main
