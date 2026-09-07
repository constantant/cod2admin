#!/bin/sh
# Shared POSIX sh helpers for cod2admin's installer scripts. Sourced (never executed directly) by
# both installer/install.sh (from wherever the admin extracted the release archive) and
# installer/apply-update.sh (from its fixed installed location, $INSTALL_DIR/bin/apply-update.sh
# — install.sh copies its own copy of this file alongside apply-update.sh at install time, see
# install_update_machinery() in install.sh). Each sources its own on-disk copy relative to itself
# — there is no cross-linking between the temp download dir and the permanent install dir.
#
# Callers must set INSTALL_DIR before using restart_service()/verify_running().

# ── Output helpers ────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_CYAN='\033[36m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''
fi

step()    { printf '\n%s==>%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
info()    { printf '    %s\n' "$1"; }
warn()    { printf '%s    warning:%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
die()     { printf '%s    error:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }
success() { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }

# ── Init system detection ────────────────────────────────────────────────────────────────────

INIT_SYSTEM="none"

detect_init_system() {
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  elif [ -d /run/openrc ] && command -v rc-service >/dev/null 2>&1; then
    INIT_SYSTEM="openrc"
  else
    INIT_SYSTEM="none"
  fi
}

# ── Restart (no unit-file writes) ────────────────────────────────────────────────────────────

# (Re)starts an already-registered cod2admin service. Does not write or regenerate unit/init
# files — install.sh's register_service() owns that, once, at install/reconfigure time. This is
# the piece apply-update.sh also needs, standalone, since applying an update never touches the
# unit file (it only repoints the $INSTALL_DIR/current symlink the unit already points at).
restart_service() {
  detect_init_system
  case $INIT_SYSTEM in
    systemd)
      systemctl restart cod2admin
      ;;
    openrc)
      # stop-if-running, then start: a plain "start" is a no-op against an already-running
      # service, which would leave it on the old symlink target.
      rc-service cod2admin stop >/dev/null 2>&1 || true
      rc-service cod2admin start
      ;;
    none)
      # $INSTALL_DIR itself is root-owned (§13.5 - cod2admin can't write into it directly), so
      # the log/pid files the su'd cod2admin shell below redirects into have to already exist and
      # be cod2admin-owned - a truncating `>` only needs write permission on the file itself, not
      # its directory, but *creating* a missing one would need directory write permission cod2admin
      # doesn't have.
      _pidfile="$INSTALL_DIR/cod2admin.pid"
      _supervisor_pidfile="$INSTALL_DIR/cod2admin-supervisor.pid"
      _logfile="$INSTALL_DIR/cod2admin.log"
      [ -f "$_logfile" ] || : > "$_logfile"
      [ -f "$_pidfile" ] || : > "$_pidfile"
      [ -f "$_supervisor_pidfile" ] || : > "$_supervisor_pidfile"
      chown cod2admin "$_logfile" "$_pidfile" "$_supervisor_pidfile"

      # Stop any previous supervisor loop *and* the app process it was running - killing just the
      # loop would leave an orphaned child running the old code behind (it isn't in the same
      # process group, so the loop dying doesn't take it down).
      if [ -f "$_supervisor_pidfile" ] && kill -0 "$(cat "$_supervisor_pidfile")" 2>/dev/null; then
        kill "$(cat "$_supervisor_pidfile")" 2>/dev/null || true
      fi
      if [ -f "$_pidfile" ] && kill -0 "$(cat "$_pidfile")" 2>/dev/null; then
        kill "$(cat "$_pidfile")" 2>/dev/null || true
        sleep 1
      fi

      # Minimal respawn loop (docs/PLAN.md §13.5) - a container with no systemd/OpenRC inside it
      # otherwise has zero crash recovery: the old one-shot `nohup ... &` here meant a crashed
      # gateway process just stayed down until someone noticed and re-ran install.sh by hand.
      # Regenerated on every call so it always reflects the current $INSTALL_DIR/start.sh.
      cat > "$INSTALL_DIR/supervise.sh" <<EOF
#!/bin/sh
while :; do
  "$INSTALL_DIR/start.sh" >> "$_logfile" 2>&1 &
  echo \$! > "$_pidfile"
  wait \$!
  printf '%s cod2admin exited - respawning in 3s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$_logfile"
  sleep 3
done
EOF
      chown cod2admin "$INSTALL_DIR/supervise.sh"
      chmod 755 "$INSTALL_DIR/supervise.sh"

      su -s /bin/sh cod2admin -c "cd '$INSTALL_DIR' && nohup ./supervise.sh </dev/null >/dev/null 2>&1 & echo \$! > '$_supervisor_pidfile'"
      ;;
  esac
}

# ── Startup verification ─────────────────────────────────────────────────────────────────────

# Waits for the service to log "cod2admin gateway started as @..." via whichever log source
# INIT_SYSTEM implies. Returns 0 on success, 1 on failure/timeout - deliberately does NOT call
# die() or exit: install.sh's first-time install has nothing to roll back to and can die()
# immediately at its own call site, but apply-update.sh needs to catch a failure and roll back
# instead of exiting. Sets VERIFY_LAST_OUTPUT to the log output seen, either way.
verify_running() {
  _log_cmd=""
  case $INIT_SYSTEM in
    systemd) _log_cmd="journalctl -u cod2admin --no-pager -n 200" ;;
    openrc|none) _log_cmd="cat $INSTALL_DIR/cod2admin.log" ;;
  esac

  _tries=0
  while true; do
    _out=$(eval "$_log_cmd" 2>/dev/null || true)
    VERIFY_LAST_OUTPUT="$_out"
    if printf '%s' "$_out" | grep -q 'cod2admin gateway started as @'; then
      success "$(printf '%s' "$_out" | grep 'cod2admin gateway started as @' | tail -n1)"
      if printf '%s' "$_out" | grep -q '/claim secret'; then
        printf '\n%s%s%s\n' "$C_YELLOW" "$(printf '%s' "$_out" | grep '/claim secret' | tail -n1)" "$C_RESET"
        info "Message your bot on Telegram with: /claim <that secret> to become its owner."
      fi
      return 0
    fi
    if printf '%s' "$_out" | grep -qi 'error\|Missing required env var'; then
      warn "The service failed to start. Recent output:"
      printf '%s\n' "$_out" >&2
      return 1
    fi
    _tries=$((_tries + 1))
    if [ "$_tries" -ge 20 ]; then
      warn "Timed out waiting for cod2admin to start. Recent output:"
      printf '%s\n' "$_out" >&2
      return 1
    fi
    sleep 1
  done
}

# ── Release pruning ──────────────────────────────────────────────────────────────────────────

# Keeps the release $CURRENT_LINK points at, plus the single next-most-recent one (by mtime), and
# deletes anything older under $RELEASES_DIR. Used after both a fresh install_app() extraction and
# a successful apply-update.sh swap, so repeated installs/updates don't grow $RELEASES_DIR
# unbounded. Requires RELEASES_DIR and CURRENT_LINK to be set by the caller.
prune_old_releases() {
  [ -d "$RELEASES_DIR" ] || return 0
  _current_target=""
  [ -L "$CURRENT_LINK" ] && _current_target=$(basename "$(readlink "$CURRENT_LINK")")

  _kept_extra=0
  for _dir in $(ls -1t "$RELEASES_DIR" 2>/dev/null); do
    [ "$_dir" = "$_current_target" ] && continue
    if [ "$_kept_extra" -lt 1 ]; then
      _kept_extra=$((_kept_extra + 1))
      continue
    fi
    rm -rf "${RELEASES_DIR:?}/$_dir"
  done
}
