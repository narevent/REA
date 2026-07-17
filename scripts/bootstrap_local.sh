#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# bootstrap_local.sh — run from YOUR machine to do the full first-time setup
# of the REA app on a fresh Debian 13 VPS over SSH.
#
# It performs, end to end, the "First-time setup" from scripts/README.md:
#
#   1. local pre-flight: verify the repo is pushed to GitHub and the local
#      exercise data exists.
#   2. on the VPS (as root, over ssh): apt + git, clone the repo, run
#      init_vps.sh.
#   3. rsync the exercise JSON (relative/, absolute/) and optionally the
#      SQLite DB from your machine into the persistent /opt/rea-data on the VPS.
#   4. on the VPS: run deploy.sh (migrate, collectstatic, import all data,
#      restart gunicorn + nginx).
#   5. (optional) install certbot and issue a Let's Encrypt cert for HTTPS.
#
# USAGE (from the project root on your local machine):
#
#   bash scripts/bootstrap_local.sh \
#       --host root@203.0.113.10 \
#       --domain rea.example.com \
#       --repo https://github.com/narevent/REA.git
#
#   # ship an existing database too:
#   bash scripts/bootstrap_local.sh --host root@1.2.3.4 --domain rea.example.com \
#       --repo https://github.com/narevent/REA.git --with-db
#
#   # also provision HTTPS:
#   bash scripts/bootstrap_local.sh ... --ssl
#
#   # non-root SSH user that can sudo (the script uses sudo on the server).
#   # Works whether that user already has passwordless sudo OR only
#   # passworded sudo (it provisions NOPASSWD once, prompting for the password
#   # on your local terminal — or pass it with --sudo-password).
#   bash scripts/bootstrap_local.sh --host ubuntu@1.2.3.4 ...
#
# All scripts/config.sh variables can be passed through with --env KEY=VAL.
# A few useful flags:
#   --branch main          git branch to deploy (default: main)
#   --data-dir ./          local root containing relative/ & absolute/
#                         (default: the directory above this script's repo)
#   --ssh-key ~/.ssh/id_ed25519   explicit identity file
#   --no-db               explicitly skip shipping the DB (default unless --with-db)
#   --skip-data           skip rsync of relative/ and absolute/ (already uploaded)
#   --sudo-password PASS  password for the non-root SSH user's sudo (used once to
#                         enable passwordless sudo; otherwise prompted interactively)
#   --no-setup-sudo       don't modify sudoers; require the SSH user to already
#                         have passwordless sudo (fails otherwise)
#
# The script is idempotent-ish: re-running it re-clones/re-inits and re-deploys.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

# ===========================================================================
# Defaults  (override with flags below)
# ===========================================================================
HOST=""                 # e.g. root@203.0.113.10  (REQUIRED)
REA_DOMAIN=""           # e.g. rea.example.com    (REQUIRED)
REA_REPO_URL=""         # e.g. https://github.com/narevent/REA.git (REQUIRED)
REA_BRANCH="main"
SSH_KEY=""              # optional -i identity
LOCAL_DATA_DIR=""       # root that holds relative/ and absolute/; auto-detected
SHIP_DB="no"            # set to "yes" with --with-db
DO_SSL="no"             # set to "yes" with --ssl
SKIP_DATA="no"          # set to "yes" with --skip-data
EXTRA_ENV=()            # KEY=VAL pairs forwarded to the server scripts
SUDO_PASSWORD=""        # one-time sudo password for NOPASSWD setup (--sudo-password)
SETUP_SUDO="yes"        # set to "no" with --no-setup-sudo to refuse sudoers changes

# Server-side path conventions (must match scripts/config.sh defaults).
REMOTE_APP_ROOT="/opt/rea5"
REMOTE_DATA_ROOT="/opt/rea-data"
REMOTE_REPO_TMP="/tmp/rea5-init"

# ===========================================================================
# Helpers
# ===========================================================================
c_blue=$'\033[1;34m'; c_grn=$'\033[1;32m'; c_ylw=$'\033[1;33m'
c_red=$'\033[1;31m'; c_rst=$'\033[0m'
log()  { printf '%s[rea]%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s[ok]%s  %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw"   "$c_rst" "$*" >&2; }
die()  { printf '%s[x]%s %s\n'  "$c_red"   "$c_rst" "$*" >&2; exit 1; }

# Build a string of common SSH args (space-separated), + optional identity.
# We return a *string* (not an array) so this works on bash 3.2 (macOS default),
# which lacks `mapfile -d ''`.  Callers split it read-only via read -a/-r.
ssh_args_str() {
  local s="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  [[ -n "$SSH_KEY" ]] && s+=" -i $SSH_KEY"
  printf '%s' "$s"
}

# Run a remote command over ssh.
remote_run() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  ssh "${base[@]}" "$HOST" "$@"
}

# Run a remote command over ssh WITH a tty (-t).  Needed for interactive sudo
# (password prompt) and any command that writes to /dev/tty.
remote_run_tty() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  ssh "${base[@]}" -t "$HOST" "$@"
}

# rsync over ssh with the same options as ssh.
rsync_run() {
  local -a base
  # shellcheck disable=SC2206
  base=( $(ssh_args_str) )
  local e="ssh "
  local i
  for i in "${base[@]}"; do e+="$i "; done
  rsync -avz --progress -e "$e" "$@"
}

# Stage a local data dir in /tmp on the server (writable by the SSH user),
# rsync it there, then sudo-move it into /opt/rea-data.  Works whether the SSH
# user is root or a non-root sudoer.  Arg: dir name (relative|absolute).
_stage_and_move() {
  local name="$1"
  local stage="/tmp/rea-${name}-$$"
  remote_run "rm -rf $stage && mkdir -p $stage" \
    || die "Could not create staging dir $stage on the server."
  rsync_run "$LOCAL_DATA_DIR/$name/" "$HOST:$stage/" \
    || die "rsync of $name/ to $stage failed."
  remote_run "$SUDO rm -rf $REMOTE_DATA_ROOT/$name && \
              $SUDO mv $stage $REMOTE_DATA_ROOT/$name && \
              $SUDO chown -R rea:rea $REMOTE_DATA_ROOT/$name" \
    || die "Could not move staged $name into $REMOTE_DATA_ROOT."
}

# Ship the local SQLite DB to /opt/rea-data/db.sqlite3 via scp + sudo-move.
_ship_db() {
  local scp_opts=( -o "BatchMode=yes" -o "StrictHostKeyChecking=accept-new"
                   -o "ConnectTimeout=15" )
  [[ -n "$SSH_KEY" ]] && scp_opts+=( -i "$SSH_KEY" )
  scp "${scp_opts[@]}" "$LOCAL_DATA_DIR/rea/db.sqlite3" "$HOST:/tmp/rea-db.sqlite3" \
    || die "scp of db.sqlite3 failed."
  remote_run "$SUDO mv /tmp/rea-db.sqlite3 $REMOTE_DATA_ROOT/db.sqlite3 && \
              $SUDO chown rea:rea $REMOTE_DATA_ROOT/db.sqlite3 && \
              $SUDO chmod 640 $REMOTE_DATA_ROOT/db.sqlite3" \
    || die "Could not place db.sqlite3 into $REMOTE_DATA_ROOT."
}

# ===========================================================================
# Parse arguments
# ===========================================================================
usage() {
  sed -n '3,/^# ---*$/p' "$0" | sed 's/^# \?//' >&2
}

print_help() {
  sed -n '3,/^# ---*$/p' "$0" | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)        HOST="$2"; shift 2 ;;
    --domain)      REA_DOMAIN="$2"; shift 2 ;;
    --repo)        REA_REPO_URL="$2"; shift 2 ;;
    --branch)      REA_BRANCH="$2"; shift 2 ;;
    --ssh-key)     SSH_KEY="$2"; shift 2 ;;
    --data-dir)    LOCAL_DATA_DIR="$2"; shift 2 ;;
    --with-db)     SHIP_DB="yes"; shift ;;
    --no-db)       SHIP_DB="no"; shift ;;
    --ssl)         DO_SSL="yes"; shift ;;
    --skip-data)   SKIP_DATA="yes"; shift ;;
    --env)         EXTRA_ENV+=("$2"); shift 2 ;;
    --sudo-password) SUDO_PASSWORD="$2"; shift 2 ;;
    --no-setup-sudo) SETUP_SUDO="no"; shift ;;
    -h|--help)     print_help ;;
    *)             usage >&2; die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ -n "$HOST" ]]         || die "--host is required (e.g. root@203.0.113.10)"
[[ -n "$REA_DOMAIN" ]]   || die "--domain is required (e.g. rea.example.com)"
[[ -n "$REA_REPO_URL" ]] || die "--repo is required (e.g. https://github.com/you/REA.git)"

# Resolve the local data dir.  This script lives in <repo>/scripts/.  In this
# project's layout, `relative/` and `absolute/` live at the REPO ROOT as
# siblings of `rea/` (and are git-ignored), so the data root is the repo root
# itself = SCRIPT_DIR/.. .
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$LOCAL_DATA_DIR" ]]; then
  LOCAL_DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
log "Local data root: $LOCAL_DATA_DIR"
log "Remote host:     $HOST"
log "Domain:          $REA_DOMAIN"
log "Repo:            $REA_REPO_URL (branch $REA_BRANCH)"
log "Ship DB:         $SHIP_DB   | SSL: $DO_SSL   | Skip data: $SKIP_DATA"

# ===========================================================================
# 1. Local pre-flight
# ===========================================================================
log "Step 1/5: local pre-flight checks"

command -v git   >/dev/null || die "git not found locally."
command -v ssh   >/dev/null || die "ssh not found locally."
command -v rsync >/dev/null || die "rsync not found locally (brew install rsync / apt install rsync)."

# Verify the working repo is clean & pushed, so the VPS clones something real.
GIT_DIR_LOCAL="$SCRIPT_DIR/.."
if git -C "$GIT_DIR_LOCAL" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "  checking local git state..."
  git -C "$GIT_DIR_LOCAL" rev-parse --abbrev-ref HEAD >/dev/null
  if [[ -n "$(git -C "$GIT_DIR_LOCAL" status --porcelain)" ]]; then
    warn "  local repo has uncommitted changes — they will NOT be on the VPS."
    warn "  commit & push first if you want them deployed."
  fi
  # Sanity: HEAD exists on origin (best-effort, ignore offline failures).
  if git -C "$GIT_DIR_LOCAL" ls-remote --heads origin "$REA_BRANCH" \
        | grep -q "$REA_BRANCH"; then
    ok "  origin has branch '$REA_BRANCH'."
  else
    warn "  could not confirm '$REA_BRANCH' on origin — make sure you pushed."
  fi
fi

# Verify local exercise data exists (unless --skip-data).
if [[ "$SKIP_DATA" == "no" ]]; then
  [[ -d "$LOCAL_DATA_DIR/relative" ]] \
    || die "No $LOCAL_DATA_DIR/relative — pass --skip-data or --data-dir."
  [[ -d "$LOCAL_DATA_DIR/absolute" ]] \
    || die "No $LOCAL_DATA_DIR/absolute — pass --skip-data or --data-dir."
  ok "  local exercise data found (relative/, absolute/)."
fi
if [[ "$SHIP_DB" == "yes" ]]; then
  [[ -f "$LOCAL_DATA_DIR/rea/db.sqlite3" ]] \
    || die "--with-db but $LOCAL_DATA_DIR/rea/db.sqlite3 not found."
  ok "  local database found."
fi

# ===========================================================================
# 2. SSH connectivity + server bootstrap
# ===========================================================================
log "Step 2/5: SSH connectivity + server bootstrap"

log "  testing SSH to $HOST ..."
remote_run 'echo "ssh ok as $(id -un) on $(hostname)"' \
  || die "Could not SSH to $HOST. Check host/key/network."
ok "  SSH connected."

# We need root privileges on the server.  If the SSH user is root, use it
# directly; otherwise we need sudo.  We accept both passwordless sudo AND a
# passworded sudoer (the latter gets elevated to passwordless for the rest of
# the run, since the bootstrap makes many separate privileged calls).
remote_is_root() {
  remote_run '[[ "$(id -u)" -eq 0 ]] && echo yes || echo no'
}
remote_user() {
  remote_run 'id -un'
}

SUDO=""          # the sudo prefix used for privileged remote calls
REMOTE_USER="$(remote_user)"
IS_ROOT="$(remote_is_root)"

if [[ "$IS_ROOT" == "yes" ]]; then
  ok "  SSH user is root — no sudo needed."
else
  # 1) Already passwordless?
  if remote_run 'sudo -n true' 2>/dev/null; then
    SUDO="sudo"
    ok "  passwordless sudo available for '$REMOTE_USER'."
  else
    if [[ "$SETUP_SUDO" == "no" ]]; then
      die "Passwordless sudo is required (or pass --sudo-password, or omit --no-setup-sudo to let this script set it up)."
    fi
    # 2) Passworded sudo -> provision passwordless sudo for this user now,
    #    using a single interactive sudo (with tty for the password prompt).
    #    The sudo password may be supplied via --sudo-password, or entered
    #    interactively on the local terminal.
    log "  '$REMOTE_USER' is not passwordless sudo. Provisioning NOPASSWD sudo..."
    if [[ -n "$SUDO_PASSWORD" ]]; then
      # Pipe the password in (no tty needed).  Use -S so sudo reads it from stdin.
      remote_run "echo '$(printf '%s' "$SUDO_PASSWORD" | sed "s/'/'\\\\''/g")' | \
                  sudo -S -p '' bash -c ' \
                    id -un >/dev/null && \
                    install -d -m 700 /etc/sudoers.d && \
                    echo \"$REMOTE_USER ALL=(ALL) NOPASSWD:ALL\" > /etc/sudoers.d/rea-bootstrap && \
                    chmod 440 /etc/sudoers.d/rea-bootstrap && \
                    visudo -cf /etc/sudoers.d/rea-bootstrap >/dev/null'" \
        || die "Could not set up passwordless sudo. Check the password / sudoers config."
    else
      # Interactive: open a tty so sudo can prompt on the *local* terminal via ssh -t.
      remote_run_tty "sudo bash -c ' \
        install -d -m 700 /etc/sudoers.d && \
        echo \"$REMOTE_USER ALL=(ALL) NOPASSWD:ALL\" > /etc/sudoers.d/rea-bootstrap && \
        chmod 440 /etc/sudoers.d/rea-bootstrap && \
        visudo -cf /etc/sudoers.d/rea-bootstrap >/dev/null && \
        echo SUDOERS_OK'" \
        || die "Could not set up passwordless sudo. Enter the password when prompted, re-run if it failed."
    fi
    # Verify it took effect.
    remote_run 'sudo -n true' \
      || die "sudoers file was written but 'sudo -n true' still fails — check /etc/sudoers.d/rea-bootstrap on the server."
    SUDO="sudo"
    ok "  passwordless sudo provisioned for '$REMOTE_USER' (/etc/sudoers.d/rea-bootstrap)."
  fi
fi

# Build the env string forwarded to init_vps.sh.
ENV_EXPORT="REA_REPO_URL=$REA_REPO_URL REA_DOMAIN=$REA_DOMAIN REA_BRANCH=$REA_BRANCH"
for kv in "${EXTRA_ENV[@]:-}"; do
  [[ -n "$kv" ]] && ENV_EXPORT+=" $kv"
done

# Install git on the server (idempotent) and clone the repo to a temp dir so we
# can run init_vps.sh, which will (re)clone into REMOTE_APP_ROOT.
log "  ensuring git is installed on the server..."
remote_run "$SUDO apt-get update -qq && $SUDO apt-get install -y -qq git ca-certificates" \
  || die "Failed to install git on the server."

# Always fetch the latest init_vps.sh onto the server (clone fresh into tmp).
log "  cloning repo to $REMOTE_REPO_TMP on the server..."
remote_run "rm -rf $REMOTE_REPO_TMP && \
            git clone --quiet --branch $REA_BRANCH $REA_REPO_URL $REMOTE_REPO_TMP" \
  || die "Failed to clone $REA_REPO_URL on the server."

log "  running init_vps.sh on the server (this installs deps, builds venv, sets up systemd + nginx)..."
remote_run "cd $REMOTE_REPO_TMP && $SUDO env $ENV_EXPORT bash scripts/init_vps.sh" \
  || die "init_vps.sh failed on the server. See output above."
ok "  init_vps.sh completed."

# ===========================================================================
# 3. Rsync exercise data (+ optional DB) to the persistent data dir
# ===========================================================================
log "Step 3/5: copying exercise data to $REMOTE_DATA_ROOT"

if [[ "$SKIP_DATA" == "yes" ]]; then
  warn "  --skip-data set; skipping rsync."
else
  # Ensure the target dirs exist.  We always stage in /tmp first (owned by the
  # SSH user) then sudo-move into place — this works whether the SSH user is
  # root or a non-root sudoer, and avoids fragile rsync --rsync-receiver hacks.
  log "  uploading relative/  -> $REMOTE_DATA_ROOT/relative/"
  _stage_and_move "relative"
  ok "  relative/ uploaded."

  log "  uploading absolute/  -> $REMOTE_DATA_ROOT/absolute/"
  _stage_and_move "absolute"
  ok "  absolute/ uploaded."

  if [[ "$SHIP_DB" == "yes" ]]; then
    log "  scp: rea/db.sqlite3 -> $REMOTE_DATA_ROOT/db.sqlite3"
    _ship_db
    ok "  db.sqlite3 uploaded."
  else
    warn "  no --with-db: a fresh empty DB will be created by deploy.sh."
  fi
fi

# ===========================================================================
# 4. Deploy
# ===========================================================================
log "Step 4/5: deploy (migrate, collectstatic, import data, restart services)"
remote_run "$SUDO bash $REMOTE_APP_ROOT/scripts/deploy.sh" \
  || die "deploy.sh failed on the server. See output above."
ok "  deploy.sh completed."

# Quick smoke test: is gunicorn up & nginx responding?
log "  smoke test..."
if remote_run "$SUDO systemctl is-active --quiet rea" 2>/dev/null; then
  ok "  gunicorn: active"
else
  warn "  gunicorn not active — check: ssh $HOST '$SUDO systemctl status rea'"
fi
remote_run "curl -fsS -o /dev/null -w 'local-nginx: HTTP %{http_code}\n' http://127.0.0.1/ || \
            curl -fsS -o /dev/null -w 'local-gunicorn: HTTP %{http_code}\n' http://127.0.0.1:8000/ || true"

ok "  app should now be live at http://$REA_DOMAIN/  (DNS must point here)."

# ===========================================================================
# 5. HTTPS via Let's Encrypt (optional)
# ===========================================================================
if [[ "$DO_SSL" == "yes" ]]; then
  log "Step 5/5: provisioning HTTPS with certbot"
  remote_run "$SUDO apt-get install -y -qq certbot python3-certbot-nginx" \
    || die "Failed to install certbot on the server."
  remote_run "$SUDO certbot --nginx -d $REA_DOMAIN --non-interactive --agree-tos \
                --register-unsafely-without-email --redirect" \
    || die "certbot failed. Make sure $REA_DOMAIN DNS points to this server."
  ok "  HTTPS provisioned."
else
  ok "Step 5/5: skipped (--ssl not set). HTTP only for now."
  warn "  when ready: bash scripts/bootstrap_local.sh ... --ssl   (or run certbot on the server)."
fi

ok "All done. Site: http://$REA_DOMAIN/"
warn "Routine updates after pushing to GitHub:"
warn "  ssh $HOST 'sudo bash $REMOTE_APP_ROOT/scripts/update.sh'"
warn "Backups:"
warn "  ssh $HOST 'sudo bash $REMOTE_APP_ROOT/scripts/backup.sh'"