#!/usr/bin/env bash
# Start/stop/status of the "CTF RUSSIA" bot (@my_cod2_admin_bot) container on the NAS.
# Stopping is clean (boot.sh traps SIGTERM); `restart: unless-stopped` keeps it down until started.
set -euo pipefail

DOCKER=/share/MD0_DATA/.qpkg/container-station/usr/bin/.libs/docker
NAME=cod2admin-ctfrussia-gateway

case "${1:-}" in
  start|stop) ssh admin@nas.local "$DOCKER ${1/stop/stop -t 30} $NAME" ;;
  status) ssh admin@nas.local "$DOCKER ps -a --filter name=$NAME --format '{{.Names}}: {{.Status}}'" ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
