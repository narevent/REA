#!/bin/bash

# CONFIGURATION
PROJECT_NAME="rea"                                    # Project name
PROJECT_DIR="/var/www/rea"                            # Project directory
BACKUP_DIR="/var/backups/rea"                         # Backup directory
SITE_URL="https://rea.vetgaaf.tech"                            # Primary site URL

SERVICE_NAME="gunicorn-${PROJECT_NAME}"

echo "================================"
echo "${PROJECT_NAME} System Status"
echo "================================"
echo ""

# System Info
echo "📊 System Information:"
echo "  Hostname: $(hostname)"
echo "  IP Address: $(hostname -I | awk '{print $1}')"
echo "  Uptime: $(uptime -p)"
echo "  Load Average: $(uptime | awk -F'load average:' '{print $2}')"
echo ""

# Disk Usage
echo "💾 Disk Usage:"
df -h / | tail -1 | awk '{printf "  Root: %s / %s (%s used)\n", $3, $2, $5}'
df -h $PROJECT_DIR 2>/dev/null | tail -1 | awk '{printf "  Project: %s / %s (%s used)\n", $3, $2, $5}' || echo "  Project: N/A"
echo ""

# Memory Usage
echo "🧠 Memory Usage:"
free -h | grep Mem | awk '{printf "  Total: %s, Used: %s, Free: %s\n", $2, $3, $4}'
echo ""

# Service Status
echo "🔧 Services:"
if systemctl is-active --quiet ${SERVICE_NAME}; then
    echo "  ✅ Gunicorn (${PROJECT_NAME}): Running"
else
    echo "  ❌ Gunicorn (${PROJECT_NAME}): Not running"
fi

if systemctl is-active --quiet nginx; then
    echo "  ✅ Nginx: Running"
else
    echo "  ❌ Nginx: Not running"
fi

if systemctl is-active --quiet certbot.timer; then
    echo "  ✅ Certbot Timer: Active"
else
    echo "  ⚠️  Certbot Timer: Inactive"
fi
echo ""

# SSL Certificate
echo "🔒 SSL Certificate:"
CERT_DOMAIN=$(echo $SITE_URL | sed 's|https://||' | sed 's|http://||' | cut -d'/' -f1)
if sudo certbot certificates 2>/dev/null | grep -q "$CERT_DOMAIN"; then
    expiry=$(sudo certbot certificates 2>/dev/null | grep "Expiry Date" | head -1 | awk '{print $3, $4}')
    echo "  ✅ Certificate installed"
    echo "  Expires: $expiry"
else
    echo "  ⚠️  No certificate found"
fi
echo ""

# Recent Errors
echo "⚠️  Recent Errors (last 10):"
error_count=$(sudo journalctl -u ${SERVICE_NAME} --since "1 hour ago" -p err --no-pager 2>/dev/null | wc -l)
if [ "$error_count" -gt 0 ]; then
    echo "  Found $error_count error(s) in last hour"
    sudo journalctl -u ${SERVICE_NAME} --since "1 hour ago" -p err --no-pager | tail -5
else
    echo "  No errors in last hour ✅"
fi
echo ""

# Database
echo "🗄️  Database:"
if [ -f "$PROJECT_DIR/db/db.sqlite3" ]; then
    db_size=$(du -h $PROJECT_DIR/db/db.sqlite3 | awk '{print $1}')
    echo "  Size: $db_size"
else
    echo "  ⚠️  Database not found"
fi
echo ""

# Last Backup
echo "💾 Last Backup:"
if [ -d "$BACKUP_DIR" ]; then
    last_backup=$(ls -t $BACKUP_DIR/full_backup_*.tar.gz 2>/dev/null | head -1)
    if [ ! -z "$last_backup" ]; then
        backup_date=$(stat -c %y "$last_backup" | cut -d'.' -f1)
        backup_size=$(du -h "$last_backup" | awk '{print $1}')
        echo "  Date: $backup_date"
        echo "  Size: $backup_size"
    else
        echo "  ⚠️  No backups found"
    fi
else
    echo "  ⚠️  Backup directory not found"
fi
echo ""

# Website Check
echo "🌐 Website Status:"
response=$(curl -s -o /dev/null -w "%{http_code}" $SITE_URL 2>/dev/null)
if [ "$response" = "200" ]; then
    echo "  ✅ Site is accessible (HTTP $response)"
else
    echo "  ⚠️  Site returned HTTP $response"
fi
echo ""

echo "================================"
echo "Quick Commands:"
echo "================================"
echo "  Restart service: sudo systemctl restart ${SERVICE_NAME} nginx"
echo "  View logs: bash scripts/logs.sh"
echo "  Update site: bash scripts/update.sh"
echo "  Create backup: bash scripts/backup.sh"
echo ""
