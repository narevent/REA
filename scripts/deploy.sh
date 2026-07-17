#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — full deploy / first-run application setup.
#
# Idempotent.  Run after init_vps.sh and once your JSON data has been placed in
# the persistent data directory ($DATA_ROOT).  Performs (in order):
#
#   1. pull latest code from origin/$REA_BRANCH
#   2. pip install -r requirements.txt   (venv updated in place)
#   3. Django: migrate, collectstatic
#   4. import all JSON data (relative + absolute key_models & lessons)
#   5. restart gunicorn + reload nginx
#
# USAGE:
#   sudo bash scripts/deploy.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "deploy.sh must run as root (use sudo)."

cd "$APP_ROOT"

# --- 1. Pull latest code ----------------------------------------------------
log "Pulling latest code from origin/$REA_BRANCH ..."
as_user "cd $APP_ROOT && git fetch --prune origin && git checkout $REA_BRANCH && git reset --hard origin/$REA_BRANCH"

# Re-link data (init_vps may have created the repo afresh and nuked symlinks).
link_data() {
  local target="$1" link="$2"
  if [[ ! -e "$target" ]]; then
    warn "Data source missing: $target — symlink will be broken until data is copied in."
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then rm -rf "$link"; fi
  if [[ ! -L "$link" ]]; then ln -s "$target" "$link"; fi
  chown -h "$ACCT" "$link"
}
link_data "$DATA_ROOT/relative" "$APP_ROOT/relative"
link_data "$DATA_ROOT/absolute" "$APP_ROOT/absolute"
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/rea/db.sqlite3"

# Ensure the service user can actually WRITE the database.  SQLite needs to
# create its journal/WAL file *next to* the (resolved) db file, i.e. inside
# $DATA_ROOT, AND the checkout's rea/ dir (where the symlink lives) must be
# writable too.  After a partial bootstrap or rsync-as-root these can end up
# root-owned, which surfaces as "attempt to write a readonly database" during
# migrate.  Normalize ownership + perms here, idempotently.
chown -R "$ACCT" "$DATA_ROOT" "$APP_ROOT/rea"
chmod 750 "$DATA_ROOT"
chmod 640 "$DATA_ROOT/db.sqlite3" 2>/dev/null || true
# The checkout's rea/ dir must be writable by the service user for the
# SQLite journal created alongside the symlinked db.sqlite3.
chmod g+w "$APP_ROOT/rea" 2>/dev/null || true

# --- 2. Python deps --------------------------------------------------------
log "Installing/updating Python dependencies..."
as_user "$VENV/bin/pip install --upgrade pip wheel"
as_user "$VENV/bin/pip install -r $APP_ROOT/rea/requirements.txt gunicorn"

# --- 3. Django housekeeping ------------------------------------------------
log "Running Django migrations + collectstatic ..."
export $(grep -v '^#' "$APP_ROOT/.env" | xargs)
cd "$APP_ROOT/rea"

as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py migrate --noinput"
as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py collectstatic --noinput --clear"

# --- 4. Import exercise data ------------------------------------------------
log "Importing exercise JSON into the database ..."
IMPORT_LOG="$APP_ROOT/rea/logs/import.log"
: > "$IMPORT_LOG"; chown "$ACCT" "$IMPORT_LOG"

import_step() {  # <label> <cmd...>
  local label="$1"; shift
  log "  $label"
  as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py $* 2>&1" >> "$IMPORT_LOG" || {
    warn "  $label reported errors — see $IMPORT_LOG"
  }
}

import_step "relative key_models"    import_key_model
import_step "relative lessons"       import_formula
import_step "absolute base"          import_absolute_base
import_step "absolute lessons"       import_absolute_lessons

# --- 5. Restart services ---------------------------------------------------
log "Restarting gunicorn and reloading nginx..."
systemctl restart "$SERVICE_NAME"
systemctl reload nginx

ok "deploy.sh complete."
warn "Service:  systemctl status $SERVICE_NAME"
warn "Logs:     tail -f $APP_ROOT/rea/logs/{access,error}.log"
warn "Import:   tail -f $IMPORT_LOG"