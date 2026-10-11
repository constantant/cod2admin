#!/bin/sh
# Creates the Debian 12 container cod2admin runs in on a host install.sh can't run on directly
# (Ubuntu 18.04 and other old systems). Run once, as root, from the folder holding this file and
# boot.sh; then install the bot inside it:
#
#   sudo sh run.sh [folder with games_mp.log]
#   sudo docker exec -it cod2admin sh /boot.sh install
#
# The container uses the host's network, so inside it 127.0.0.1 is this machine: the bot reaches
# RCON on 127.0.0.1, and Caddy listens on the host's ports 80/443 for the Mini App.
#
# Kept on the host, next to this file (./data): the database and the HTTPS certificates. The bot's
# own files live in the container - `docker stop/start/restart` keep them, `docker rm` doesn't
# (then run this and the install again; admins, bans and history are still there).
set -eu

NAME=${COD2ADMIN_NAME:-cod2admin}
IMAGE=${COD2ADMIN_IMAGE:-debian:12}
NETWORK=${COD2ADMIN_NETWORK:-host}
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
DATA_DIR=${COD2ADMIN_DATA_DIR:-$SCRIPT_DIR/data}
LOG_DIR=${1:-}

die() { echo "error: $1" >&2; exit 1; }
warn() { echo "warning: $1" >&2; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo sh run.sh ...)."
command -v docker >/dev/null 2>&1 || die "Docker isn't installed (on Ubuntu: apt-get install docker.io)."
[ -f "$SCRIPT_DIR/boot.sh" ] || die "boot.sh must be in the same folder as run.sh."
if docker inspect "$NAME" >/dev/null 2>&1; then
  die "a container named $NAME already exists. To start over: docker rm -f $NAME"
fi

if [ -n "$LOG_DIR" ]; then
  [ -d "$LOG_DIR" ] || die "$LOG_DIR is not a folder (give the folder games_mp.log is in, not the file)."
  LOG_DIR=$(cd -- "$LOG_DIR" && pwd)
  [ -f "$LOG_DIR/games_mp.log" ] || warn "no games_mp.log in $LOG_DIR yet - check the path."
fi

# With the host's network, the bot's own Postgres and Mini App server take these loopback ports.
if [ "$NETWORK" = "host" ] && command -v ss >/dev/null 2>&1; then
  for _port in 5432 18090; do
    if ss -ltn 2>/dev/null | grep -q ":$_port "; then
      warn "port $_port is already in use on this machine - the bot needs it free."
    fi
  done
fi

mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/caddy"

set -- -d --name "$NAME" --restart unless-stopped --init --network "$NETWORK" --stop-timeout 60 \
  -v "$SCRIPT_DIR/boot.sh:/boot.sh:ro" \
  -v "$DATA_DIR/postgres:/var/lib/postgresql/cod2admin-data" \
  -v "$DATA_DIR/caddy:/root/.local/share/caddy"
[ -n "$LOG_DIR" ] && set -- "$@" -v "$LOG_DIR:/cod2-logs:ro"

# shellcheck disable=SC2086 # COD2ADMIN_DOCKER_ARGS is extra `docker run` options, split on purpose
docker run "$@" ${COD2ADMIN_DOCKER_ARGS:-} "$IMAGE" sh /boot.sh >/dev/null

echo "Container $NAME is running."
echo "Next: docker exec -it $NAME sh /boot.sh install"
[ -n "$LOG_DIR" ] && echo "When the installer asks for the log path, answer: /cod2-logs/games_mp.log"
exit 0
