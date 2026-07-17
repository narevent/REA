#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh — snapshot the SQLite DB and the JSON exercise data to a gzipped
# tarball in $BACKUP_DIR.  Keeps a configurable number of recent backups.
#
# Backs up:
#   - $DATA_ROOT/db.sqlite3     (via .backup for a consistent, safe copy)
#   - $DATA_ROOT/relative/      (all key_models + lessons JSON)
#   - $DATA_ROOT/absolute/      (all absolute base + lessons JSON)
#   - $APP_ROOT/.env            (secrets — keep backups secure!)
#
# USAGE:
#   sudo bash scripts/backup.sh                 # keep last 14 backups
#   sudo KEEP=30 bash scripts/backup.sh         # keep last 30
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

: "${KEEP:=14}"

[[ "$(id -u)" -eq 0 || "$(id -un)" == "$SERVICE_USER" ]] \
  || die "backup.sh must run as root or the $SERVICE_USER user."

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/rea-backup-$stamp.tar.gz"

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$BACKUP_DIR"

log "Creating backup -> $archive"

# Stage a consistent copy of the DB (SQLite .backup is crash-safe even if the
# app is writing to it).  Using a short-lived file so we don't touch the live DB.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ -f "$DATA_ROOT/db.sqlite3" ]]; then
  if [[ -x "$VENV/bin/python" ]]; then
    as_user "$VENV/bin/python -c \"import sqlite3;sqlite3.connect('$DATA_ROOT/db.sqlite3').backup(sqlite3.connect('$STAGE/db.sqlite3'))\""
  else
    # Fallback: sqlite3 CLI (still safe, but holds a brief lock).
    sqlite3 "$DATA_ROOT/db.sqlite3" ".backup '$STAGE/db.sqlite3'"
  fi
fi

# Copy the JSON data dirs verbatim.
[[ -d "$DATA_ROOT/relative" ]] && cp -a "$DATA_ROOT/relative" "$STAGE/relative"
[[ -d "$DATA_ROOT/absolute" ]] && cp -a "$DATA_ROOT/absolute" "$STAGE/absolute"

# Capture .env for completeness (contains the secret key — protect the archive!).
[[ -f "$APP_ROOT/.env" ]] && cp -a "$APP_ROOT/.env" "$STAGE/env"

tar -czf "$archive" -C "$STAGE" .
chown "$ACCT" "$archive"
chmod 640 "$archive"

ok "Wrote $archive ($(du -h "$archive" | cut -f1))."

# --- Rotation ---------------------------------------------------------------
log "Rotating — keeping last $KEEP backups..."
mapfile -t old < <(ls -1t "$BACKUP_DIR"/rea-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [[ ${#old[@]} -gt 0 ]]; then
  printf '  removing: %s\n' "${old[@]}"
  rm -f "${old[@]}"
fi

ok "backup.sh complete."