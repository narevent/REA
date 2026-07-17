#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Shared configuration for the REA deployment scripts.
#
# Override any of these with environment variables BEFORE running a script, or
# edit the defaults below.  All scripts `source` this file.
#
#   e.g.  sudo REA_DOMAIN=rea.example.com REA_REPO_URL=git@github.com:me/rea5.git \
#           bash scripts/init_vps.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail

# --- Identity ---------------------------------------------------------------
# The git URL of the app repository (without the exercise data).
: "${REA_REPO_URL:?config.sh: REA_REPO_URL is required (e.g. https://github.com/you/rea5.git)}"

# Public hostname the site is served from.
: "${REA_DOMAIN:=localhost}"

# --- Paths ------------------------------------------------------------------
# Where the git checkout lives (the app code).
: "${APP_ROOT:=/opt/rea5}"

# Persistent data directory that survives deploys/updates.  Holds:
#   relative/          -> JSON key_models + lessons (symlinked into APP_ROOT)
#   absolute/          -> JSON absolute base + lessons (symlinked into APP_ROOT)
#   db.sqlite3         -> the SQLite database (symlinked into APP_ROOT/rea)
: "${DATA_ROOT:=/opt/rea-data}"

# Python virtualenv used by the app.
: "${VENV:=$APP_ROOT/.venv}"

# Where backups are written (backup.sh) / read from (restore.sh).
: "${BACKUP_DIR:=/opt/rea-backups}"

# --- Service names ----------------------------------------------------------
: "${SERVICE_NAME:=rea}"
: "${SERVICE_USER:=rea}"
: "${SERVICE_GROUP:=rea}"

# --- App runtime ------------------------------------------------------------
: "${REA_PORT:=8000}"                 # gunicorn bind (unix socket by default)
: "${GUNICORN_WORKERS:=3}"
: "${REA_DEBUG:=false}"               # production default

# The git branch/tag to deploy and track for updates.
: "${REA_BRANCH:=main}"

# Internal helpers -----------------------------------------------------------
ACCT="$SERVICE_USER:$SERVICE_GROUP"
readonly APP_ROOT DATA_ROOT VENV BACKUP_DIR SERVICE_NAME SERVICE_USER SERVICE_GROUP

# Pretty logging.
log()  { printf '\033[1;34m[rea]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# Run a command as the service user (preserves $VENV activation).
as_user() {
  if [[ "$(id -u)" -eq 0 ]]; then
    sudo -u "$SERVICE_USER" -EH bash -lc "$*"
  else
    bash -lc "$*"
  fi
}