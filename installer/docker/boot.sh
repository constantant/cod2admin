#!/bin/sh
# cod2admin in a Debian 12 container, for hosts install.sh can't run on directly (Ubuntu 18.04
# and other old systems without Node 20 packages). Mounted into the container by run.sh.
#
#   sh /boot.sh             container command: starts what install.sh set up (Postgres, Caddy,
#                           the bot's respawn loop) on every container start, since there is no
#                           systemd in here to do it, and stops it all cleanly on `docker stop`.
#   sh /boot.sh install     downloads the latest release and runs its install.sh in here. Extra
#                           arguments go to install.sh (e.g. --config /path/to/file).
INSTALL_DIR=/opt/cod2admin
PGDATA=/var/lib/postgresql/cod2admin-data
CADDYFILE=/etc/caddy/Caddyfile
RELEASES_API=https://api.github.com/repos/constantant/cod2admin/releases/latest

# Caddy keeps its certificates under $HOME; the same value here and in `docker exec` keeps them
# in the one folder run.sh mounts from the host.
export HOME=/root

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) boot: $*"; }

pg_bin_dir() { ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -n1; }

install_bot() {
  set -e
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl iproute2 procps
  # Not under /root: install.sh runs psql as the postgres user from here, which must be able to
  # enter the folder.
  _work=/var/tmp/cod2admin-installer
  rm -rf "$_work"
  mkdir -p "$_work"
  cd "$_work"
  _url=$(curl -fsS "$RELEASES_API" | grep browser_download_url | grep -v gateway | cut -d '"' -f 4 | head -n1)
  [ -n "$_url" ] || { echo "Could not find the latest release at $RELEASES_API" >&2; exit 1; }
  echo "Downloading $_url"
  curl -fL -o release.tar.gz "$_url"
  tar -xzf release.tar.gz
  cd cod2admin-*/
  exec ./install.sh "$@"
}

start_all() {
  _pgbin=$(pg_bin_dir)
  if [ -n "$_pgbin" ] && [ -f "$PGDATA/PG_VERSION" ]; then
    # Nothing can be running yet at container start, so any postmaster.pid is stale (left by an
    # unclean stop) and would block startup if its PID got reused.
    mkdir -p /run/postgresql && chown postgres:postgres /run/postgresql
    rm -f "$PGDATA/postmaster.pid"
    su -s /bin/sh postgres -c "$_pgbin/pg_ctl -D $PGDATA -l $PGDATA/server.log -o '-h 127.0.0.1' -w start" >/dev/null \
      && log "started postgres" \
      || log "postgres failed to start, see $PGDATA/server.log"
  fi

  if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/cod2admin.caddy ]; then
    caddy start --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 \
      && log "started caddy (Mini App HTTPS)" \
      || log "caddy failed to start, check: caddy validate --config $CADDYFILE"
  fi

  # Same launch install.sh's restart_service() uses: supervise.sh respawns the bot if it exits.
  su -s /bin/sh cod2admin -c "cd $INSTALL_DIR && nohup ./supervise.sh </dev/null >/dev/null 2>&1 & echo \$! > $INSTALL_DIR/cod2admin-supervisor.pid"
  log "started the bot (log: $INSTALL_DIR/cod2admin.log)"
}

stop_all() {
  log "stopping"
  [ -f "$INSTALL_DIR/cod2admin-supervisor.pid" ] && kill "$(cat "$INSTALL_DIR/cod2admin-supervisor.pid")" 2>/dev/null
  [ -f "$INSTALL_DIR/cod2admin.pid" ] && kill "$(cat "$INSTALL_DIR/cod2admin.pid")" 2>/dev/null
  command -v caddy >/dev/null 2>&1 && caddy stop >/dev/null 2>&1
  _pgbin=$(pg_bin_dir)
  [ -n "$_pgbin" ] && su -s /bin/sh postgres -c "$_pgbin/pg_ctl -D $PGDATA -m fast -w stop" >/dev/null 2>&1
  exit 0
}

if [ "${1:-}" = "install" ]; then
  shift
  install_bot "$@"
fi

trap stop_all TERM INT

if [ -x "$INSTALL_DIR/supervise.sh" ] && id cod2admin >/dev/null 2>&1; then
  start_all
elif [ -f "$PGDATA/PG_VERSION" ]; then
  # The database is on the host, but the bot's files lived in the old container.
  log "this container was re-created: run 'docker exec -it <name> sh /boot.sh install' again (admins, bans and history are kept)"
else
  log "nothing installed yet: run 'docker exec -it <name> sh /boot.sh install'"
fi

sleep infinity &
wait $!
