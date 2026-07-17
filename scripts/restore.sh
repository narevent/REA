#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore.sh — restore a backup produced by backup.sh.
#
# Stops the app, restores the database, the JSON data and .env into the
# persistent data directory, then re-links and restarts the app.
#
# USAGE:
#   sudo bash scripts/restore.sh                                 # latest backup
#   sudo bash scripts/restore.sh /opt/rea-backups/rea-backup-20260717T...tar.gz
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "restore.sh must run as root (use sudo)."

# --- Resolve the archive ----------------------------------------------------
if [[ $# -ge 1 ]]; then
  archive="$1"
else
  archive="$(ls -1t "$BACKUP_DIR"/rea-backup-*.tar.gz 2>/dev/null | head -n1 || true)"
  [[ -n "$archive" ]] || die "No backup found in $BACKUP_DIR. Pass a path explicitly."
fi
[[ -f "$archive" ]] || die "Backup not found: $archive"
log "Restoring from: $archive"

# --- Stop the app so we don't restore into a live DB -----------------------
log "Stopping $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

# --- Extract to a staging area ---------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$archive" -C "$STAGE"

# --- Restore the database ---------------------------------------------------
if [[ -f "$STAGE/db.sqlite3" ]]; then
  log "Restoring database -> $DATA_ROOT/db.sqlite3"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$DATA_ROOT"
  # Preserve a copy of the current DB just in case.
  if [[ -f "$DATA_ROOT/db.sqlite3" && ! -L "$DATA_ROOT/db.sqlite3" ]]; then
    cp -a "$DATA_ROOT/db.sqlite3" "$DATA_ROOT/db.sqlite3.pre-restore.$(date +%s)"
  fi
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 640 "$STAGE/db.sqlite3" "$DATA_ROOT/db.sqlite3"
fi

# --- Restore JSON data ------------------------------------------------------
restore_dir() {  # <name>
  local name="$1"
  if [[ -d "$STAGE/$name" ]]; then
    log "Restoring $name -> $DATA_ROOT/$name"
    rm -rf "$DATA_ROOT/$name"
    cp -a "$STAGE/$name" "$DATA_ROOT/$name"
    chown -R "$ACCT" "$DATA_ROOT/$name"
  fi
}
restore_dir relative
restore_dir absolute

# --- Restore .env -----------------------------------------------------------
if [[ -f "$STAGE/env" ]]; then
  log "Restoring .env -> $APP_ROOT/.env"
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 600 "$STAGE/env" "$APP_ROOT/.env"
fi

# --- Re-link data into the checkout ----------------------------------------
link_data() {
  local target="$1" link="$2"
  if [[ -e "$link" && ! -L "$link" ]]; then rm -rf "$link"; fi
  [[ -L "$link" ]] || ln -s "$target" "$link"
  chown -h "$ACCT" "$link"
}
link_data "$DATA_ROOT/relative"      "$APP_ROOT/relative"
link_data "$DATA_ROOT/absolute"      "$APP_ROOT/absolute"
link_data "$DATA_ROOT/db.sqlite3"    "$APP_ROOT/rea/db.sqlite3"

# --- Rebuild static + restart ----------------------------------------------
log "collectstatic ..."
as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py collectstatic --noinput --clear" || \
  warn "collectstatic failed — check the venv / repo."

log "Starting $SERVICE_NAME ..."
systemctl start "$SERVICE_NAME"
systemctl reload nginx 2>/dev/null || true

ok "restore.sh complete."