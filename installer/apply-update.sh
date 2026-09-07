#!/bin/sh
# cod2admin's root-run update applier (docs/PLAN.md §13.4). Installed by install.sh at
# $INSTALL_DIR/bin/apply-update.sh, invocable by the unprivileged `cod2admin` service user only
# via the narrow sudoers.d rule install.sh also installs (installer/sudoers-cod2admin) - scoped to
# exactly this script and to arguments under $INSTALL_DIR/staging/.
#
# Deliberately minimal: applies an ALREADY-STAGED, ALREADY-TRUSTED gateway tarball. It does not
# download anything or verify a checksum - that happens one layer up, in the (not yet built)
# Telegram /update command (docs/PLAN.md §13.3), before it invokes this via sudo. Kept small and
# dumb on purpose, since this is the one piece of the update path that runs as root.
#
# Usage: apply-update.sh <path to cod2admin-gateway-VERSION.tar.gz, under $INSTALL_DIR/staging/>
#
# POSIX sh on purpose, same reasoning as install.sh (Alpine has no bash).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# apply-update.sh always lives at $INSTALL_DIR/bin/apply-update.sh - derive INSTALL_DIR from its
# own location rather than hardcoding /opt/cod2admin, so a custom --install-dir (install.sh) still
# works.
INSTALL_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
RELEASES_DIR="$INSTALL_DIR/releases"
CURRENT_LINK="$INSTALL_DIR/current"
STAGING_DIR="$INSTALL_DIR/staging"
LOG_FILE="$INSTALL_DIR/update.log"
LOCK_DIR="$INSTALL_DIR/update.lock"

# shellcheck source=lib/service.sh
. "$SCRIPT_DIR/lib/service.sh"

log_line() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

# Wraps die()/warn() so every fatal or noteworthy line also lands in update.log - this runs
# unattended (via sudo, eventually via Telegram), so it has to be debuggable without a terminal
# attached.
fail() {
  log_line "ERROR: $1"
  die "$1"
}

[ "$(id -u)" -eq 0 ] || fail "apply-update.sh must run as root (invoked via sudo)."

TARBALL=${1:-}
[ -n "$TARBALL" ] || fail "Usage: apply-update.sh <path to cod2admin-gateway-VERSION.tar.gz>"
[ -f "$TARBALL" ] || fail "Not a file: $TARBALL"

# Resolve to an absolute path and require it to live under $STAGING_DIR/ - matches the sudoers
# rule's own argument pattern, and means this script never extracts something from outside the
# one directory the unprivileged caller can write to.
TARBALL_DIR=$(cd -- "$(dirname -- "$TARBALL")" && pwd)
TARBALL="$TARBALL_DIR/$(basename -- "$TARBALL")"
case "$TARBALL" in
  "$STAGING_DIR"/*) ;;
  *) fail "Refusing to apply a tarball outside $STAGING_DIR: $TARBALL" ;;
esac

TARBALL_NAME=$(basename -- "$TARBALL")
case "$TARBALL_NAME" in
  cod2admin-gateway-*.tar.gz) ;;
  *) fail "Not a cod2admin-gateway tarball: $TARBALL_NAME" ;;
esac
VERSION=${TARBALL_NAME#cod2admin-gateway-}
VERSION=${VERSION%.tar.gz}

if [ -d "$LOCK_DIR" ] || ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "Another update is already in progress (found $LOCK_DIR). If that's stale (a previous run crashed), remove it and retry."
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

log_line "Applying $TARBALL_NAME (version $VERSION)"
step "Applying update to v$VERSION"

# ── Tar-member safety check ──────────────────────────────────────────────────────────────────
# Extraction below runs as root - reject anything that could escape $RELEASES_DIR/$VERSION via an
# absolute path or a ".." segment before extracting a single byte.
info "Checking archive contents"
if tar -tzf "$TARBALL" | grep -E '(^|/)\.\.(/|$)|^/' >/dev/null; then
  fail "$TARBALL_NAME contains unsafe member paths (absolute or '..') - refusing to extract."
fi

# ── Extract ───────────────────────────────────────────────────────────────────────────────────
RELEASE_DIR="$RELEASES_DIR/$VERSION"
if [ -d "$RELEASE_DIR" ]; then
  warn "Release directory $RELEASE_DIR already exists - overwriting."
  rm -rf "$RELEASE_DIR"
fi
mkdir -p "$RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR" --strip-components=1
chown -R root:root "$RELEASE_DIR"
# Read/execute for everyone (the unprivileged cod2admin service user needs to run node against
# this), no write access for anyone but root - the service can't modify its own code.
chmod -R a+rX "$RELEASE_DIR"
success "Extracted to $RELEASE_DIR"

# ── Swap + restart ────────────────────────────────────────────────────────────────────────────
OLD_TARGET=""
[ -L "$CURRENT_LINK" ] && OLD_TARGET=$(readlink "$CURRENT_LINK")

info "Switching current -> releases/$VERSION"
ln -sfn "releases/$VERSION" "$CURRENT_LINK"

step "Restarting the service"
restart_service

if verify_running; then
  log_line "Update to v$VERSION succeeded."
  prune_old_releases
  rm -f "$TARBALL" "$STAGING_DIR/pending-update.env"
  step "Done"
  success "cod2admin is running v$VERSION."
  exit 0
fi

# ── Rollback ──────────────────────────────────────────────────────────────────────────────────
warn "New version failed to start - rolling back."
log_line "Update to v$VERSION FAILED - rolling back to ${OLD_TARGET:-<none>}."

if [ -n "$OLD_TARGET" ]; then
  ln -sfn "$OLD_TARGET" "$CURRENT_LINK"
  restart_service
  if verify_running; then
    log_line "Rollback to $OLD_TARGET succeeded."
    warn "Rolled back to the previous version successfully."
  else
    log_line "Rollback to $OLD_TARGET ALSO FAILED - service is down. Manual intervention needed."
    warn "Rollback also failed - the service may be down. Check $LOG_FILE and the service logs."
  fi
else
  log_line "No previous version to roll back to - service is down. Manual intervention needed."
  warn "No previous version recorded to roll back to - the service may be down."
fi

# Best-effort Telegram alert - only this script can see the failure, since the new process never
# came up to report it itself. Silently skipped if there's no bot token or no pending-update
# marker (the marker is written by the future /update command, docs/PLAN.md §13.3 - this script
# is also usable standalone, by an admin running it by hand, before that command exists).
notify_failure() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  _token=$(grep '^TELEGRAM_BOT_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
  [ -n "$_token" ] || return 0
  [ -f "$STAGING_DIR/pending-update.env" ] || return 0
  _chat_id=$(grep '^CHAT_ID=' "$STAGING_DIR/pending-update.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
  [ -n "$_chat_id" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  _text="❌ Update to v$VERSION failed and was rolled back"
  if [ -n "$OLD_TARGET" ] && printf '%s' "$OLD_TARGET" | grep -q '^releases/'; then
    _text="$_text to v${OLD_TARGET#releases/}."
  else
    _text="$_text, but no previous version could be restored - the bot may be down. Check $LOG_FILE."
  fi
  curl -s -X POST "https://api.telegram.org/bot${_token}/sendMessage" \
    --data-urlencode "chat_id=${_chat_id}" \
    --data-urlencode "text=${_text}" >/dev/null 2>&1 || true
}
notify_failure

exit 1
