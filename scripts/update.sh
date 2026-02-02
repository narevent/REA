#!/bin/bash
set -e

# CONFIGURATION
PROJECT_NAME="rea"                                    # Project name
PROJECT_DIR="/var/www/rea"                            # Project directory
PRIMARY_DOMAIN="rea.vetgaaf.tech"                              # Primary domain

SERVICE_NAME="gunicorn-${PROJECT_NAME}"

echo "================================"
echo "${PROJECT_NAME} Update Script"
echo "================================"

# Change to project directory
cd $PROJECT_DIR

echo "Pulling latest changes from GitHub..."
# Stash any local changes (like collected static files, db, etc.)
sudo -u www-data git stash
sudo -u www-data git pull origin main

echo "Installing/updating Python dependencies..."
sudo -u www-data $PROJECT_DIR/venv/bin/pip install -r requirements.txt --upgrade

echo "Running migrations..."
sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py migrate

echo "Compiling translations..."
if [ -d "$PROJECT_DIR/locale" ]; then
    sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py compilemessages || echo "No translations to compile"
fi

echo "Collecting static files..."
sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py collectstatic --noinput

echo "Restarting Gunicorn..."
sudo systemctl restart ${SERVICE_NAME}

echo "Reloading Nginx..."
sudo systemctl reload nginx

echo ""
echo "================================"
echo "Update Complete!"
echo "================================"
echo ""
echo "Service status:"
sudo systemctl status ${SERVICE_NAME} --no-pager | head -5
echo ""
echo "Recent logs (last 20 lines):"
sudo journalctl -u ${SERVICE_NAME} -n 20 --no-pager
echo ""
echo "Site is running at: https://${PRIMARY_DOMAIN}"
echo ""
