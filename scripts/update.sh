#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update.sh — pull the latest code from GitHub and apply it, without a full
# re-import of the exercise data.
#
# Intended for routine "I pushed a new commit, ship it" updates.  Runs:
#   1. git fetch + reset --hard origin/$REA_BRANCH
#   2. pip install -r requirements.txt   (only if changed)
#   3. migrate --noinput
#   4. collectstatic --noinput --clear
#   5. systemctl restart gunicorn ; reload nginx
#
# Use deploy.sh instead when you also want to (re)import the JSON data.
#
# USAGE:
#   sudo bash scripts/update.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "update.sh must run as root (use sudo)."

cd "$APP_ROOT"

# --- 1. Pull ---------------------------------------------------------------
log "Fetching latest from origin/$REA_BRANCH ..."
OLD_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"
as_user "cd $APP_ROOT && git fetch --prune origin && git checkout $REA_BRANCH && git reset --hard origin/$REA_BRANCH"
NEW_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  ok "Already up to date ($NEW_SHA). Nothing to do."
  exit 0
fi
log "Updated: $OLD_SHA -> $NEW_SHA"

# Re-establish data symlinks in case a repo path changed them.
for pair in "$DATA_ROOT/relative:$APP_ROOT/relative" \
            "$DATA_ROOT/absolute:$APP_ROOT/absolute" \
            "$DATA_ROOT/db.sqlite3:$APP_ROOT/rea/db.sqlite3"; do
  target="${pair%%:*}"; link="${pair##*:}"
  [[ -L "$link" ]] || { rm -rf "$link"; ln -s "$target" "$link"; chown -h "$ACCT" "$link"; }
done

# --- 2. Python deps (only if requirements.txt changed) --------------------
if git -C "$APP_ROOT" diff --name-only "$OLD_SHA" "$NEW_SHA" | grep -q '^rea/requirements.txt$'; then
  log "requirements.txt changed — reinstalling deps..."
  as_user "$VENV/bin/pip install -r $APP_ROOT/rea/requirements.txt gunicorn"
else
  log "requirements.txt unchanged; skipping pip install."
fi

# --- 3. Django housekeeping ------------------------------------------------
log "migrate + collectstatic ..."
as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py migrate --noinput"
as_user "cd $APP_ROOT/rea && $VENV/bin/python manage.py collectstatic --noinput --clear"

# --- 4. Restart ------------------------------------------------------------
log "Restarting gunicorn, reloading nginx..."
systemctl restart "$SERVICE_NAME"
systemctl reload nginx

ok "update.sh complete -> $NEW_SHA"