#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# init_vps.sh — one-time bootstrap of a freshly installed Debian 13 VPS.
#
# Installs system deps, creates the service user, clones the repo, sets up the
# persistent data directory, the Python venv, the Gunicorn systemd service and
# the Nginx reverse proxy.
#
# USAGE (run as root on a fresh Debian 13 box):
#   sudo REA_REPO_URL=https://github.com/you/rea5.git \
#        REA_DOMAIN=rea.example.com \
#        bash scripts/init_vps.sh
#
# After it finishes, copy your JSON data into /opt/rea-data/relative and
# /opt/rea-data/absolute (and a db.sqlite3 if you have one), then run:
#   sudo bash /opt/rea5/scripts/deploy.sh
# ---------------------------------------------------------------------------
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$SCRIPT_DIR/config.sh"

[[ "$(id -u)" -eq 0 ]] || die "init_vps.sh must run as root (use sudo)."

# --- 1. System packages -----------------------------------------------------
log "Updating apt and installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git python3 python3-venv python3-dev \
  build-essential libssl-dev libffi-dev \
  nginx ufw sqlite3 rsync

# --- 2. Service user --------------------------------------------------------
if ! id "$SERVICE_USER" &>/dev/null; then
  log "Creating service user '$SERVICE_USER'..."
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" \
          --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
fi

# Allow the service user to read the repo while root sets things up.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 "$(dirname "$APP_ROOT")"

# --- 3. Clone the repo ------------------------------------------------------
if [[ ! -d "$APP_ROOT/.git" ]]; then
  log "Cloning $REA_REPO_URL -> $APP_ROOT ..."
  if [[ "$REA_REPO_URL" == git@github.com:* ]]; then
    die "SSH repo URL requires deploy keys. Use an HTTPS URL for init_vps.sh, e.g. https://github.com/you/rea5.git"
  fi
  # Clone as the SERVICE USER so the working tree is owned by them from the
  # start (avoids git's "dubious ownership" error on re-runs, and avoids a
  # later chown -R over many files).
  as_user "git clone --branch $REA_BRANCH $REA_REPO_URL $APP_ROOT"
else
  log "Repo already present at $APP_ROOT; fetching latest..."
  # Run git as the SERVICE USER: the repo is owned by them (we chowned it on
  # the first run), and root operating on another user's repo triggers git's
  # "dubious ownership" safe.directory refusal.
  as_user "git -C $APP_ROOT fetch --prune origin"
  as_user "git -C $APP_ROOT checkout $REA_BRANCH"
  as_user "git -C $APP_ROOT reset --hard origin/$REA_BRANCH"
fi
chown -R "$ACCT" "$APP_ROOT"

# --- 4. Persistent data directory ------------------------------------------
log "Creating persistent data dir at $DATA_ROOT ..."
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 \
  "$DATA_ROOT/relative/key_models" \
  "$DATA_ROOT/relative/lessons" \
  "$DATA_ROOT/absolute/key_models" \
  "$DATA_ROOT/absolute/lessons"

# Place an empty DB so the first deploy can migrate without a copy.
if [[ ! -f "$DATA_ROOT/db.sqlite3" ]]; then
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 640 /dev/null "$DATA_ROOT/db.sqlite3"
fi

# --- 5. Python virtualenv + deps -------------------------------------------
log "Creating virtualenv and installing Python deps..."
as_user "python3 -m venv $VENV"
as_user "$VENV/bin/pip install --upgrade pip wheel"
as_user "$VENV/bin/pip install -r $APP_ROOT/rea/requirements.txt gunicorn"

# --- 6. Secret key ---------------------------------------------------------
ENV_FILE="$APP_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating $ENV_FILE ..."
  if [[ -x "$VENV/bin/python" ]]; then
    SECRET="$("$VENV/bin/python" -c 'import secrets;print(secrets.token_urlsafe(60))')"
  else
    SECRET="$(openssl rand -base64 48)"
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
REA_SECRET_KEY=$SECRET
REA_DEBUG=$REA_DEBUG
REA_DOMAIN=$REA_DOMAIN
EOF
  chown "$ACCT" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# --- 7. Symlinks for data into the checkout --------------------------------
link_data() {  # <target dir/file> <link path>
  local target="$1" link="$2"
  if [[ -e "$link" || -L "$link" ]]; then rm -rf "$link"; fi
  ln -s "$target" "$link"
  chown -h "$ACCT" "$link"
}
log "Symlinking data directories into the checkout..."
link_data "$DATA_ROOT/relative" "$APP_ROOT/relative"
link_data "$DATA_ROOT/absolute" "$APP_ROOT/absolute"
link_data "$DATA_ROOT/db.sqlite3" "$APP_ROOT/rea/db.sqlite3"

# --- 8. Directories gunicorn/nginx need ------------------------------------
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 \
  "$APP_ROOT/rea/static" "$APP_ROOT/rea/logs"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 755 "$(dirname "$BACKUP_DIR")"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 750 "$BACKUP_DIR"

# --- 9. systemd service ----------------------------------------------------
log "Installing systemd service..."
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=REA Django app (Gunicorn)
After=network.target

[Service]
Type=notify
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_ROOT/rea
EnvironmentFile=$APP_ROOT/.env
ExecStart=$VENV/bin/gunicorn \\
    --workers $GUNICORN_WORKERS \\
    --bind 127.0.0.1:$REA_PORT \\
    --access-logfile $APP_ROOT/rea/logs/access.log \\
    --error-logfile  $APP_ROOT/rea/logs/error.log \\
    config.wsgi:application
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

# --- 10. Nginx site --------------------------------------------------------
log "Configuring Nginx..."
NGINX_SITE="/etc/nginx/sites-available/$SERVICE_NAME"
cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $REA_DOMAIN;

    client_max_body_size 25m;

    location /static/ {
        alias $APP_ROOT/rea/static/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:$REA_PORT;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect off;
    }
}
EOF
ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/$SERVICE_NAME"
rm -f /etc/nginx/sites-enabled/default
nginx -t

# --- 11. Firewall (optional, non-fatal) ------------------------------------
if command -v ufw >/dev/null; then
  log "Opening firewall ports 22, 80, 443..."
  ufw allow OpenSSH || true
  ufw allow 'Nginx Full' || true
  y | ufw enable || true
fi

# --- 12. Enable + start ----------------------------------------------------
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" nginx

ok "init_vps.sh done."
warn "Next steps:"
warn "  1. Copy your exercise JSON into $DATA_ROOT/relative and $DATA_ROOT/absolute"
warn "     (and optionally a db.sqlite3 into $DATA_ROOT/db.sqlite3)."
warn "  2. Run:  sudo bash $APP_ROOT/scripts/deploy.sh"
warn "  3. (optional, for HTTPS) install certbot:"
warn "        apt-get install -y certbot python3-certbot-nginx"
warn "        certbot --nginx -d $REA_DOMAIN"