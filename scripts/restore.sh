#!/bin/bash
set -e

# CONFIGURATION
PROJECT_NAME="'"${PROJECT_NAME}"'"                                    # Project name
PROJECT_DIR="'"${PROJECT_DIR_PATH}"'"                            # Project directory
BACKUP_DIR="'"${BACKUP_DIR_PATH}"'"                         # Backup directory


SERVICE_NAME="gunicorn-${PROJECT_NAME}"

echo "================================"
echo "${PROJECT_NAME} Restore Script"
echo "================================"

# List available backups
echo "Available backups:"
sudo ls -lh $BACKUP_DIR/full_backup_*.tar.gz

echo ""
echo "Enter the backup filename to restore (e.g., full_backup_20250125_120000.tar.gz):"
read -r backup_file

if [ ! -f "$BACKUP_DIR/$backup_file" ]; then
    echo "Error: Backup file not found!"
    exit 1
fi

echo ""
echo "WARNING: This will overwrite current database and media files!"
echo "Are you sure you want to continue? (yes/no)"
read -r confirm

if [ "$confirm" != "yes" ]; then
    echo "Restore cancelled."
    exit 0
fi

# Stop Gunicorn
echo "Stopping Gunicorn..."
sudo systemctl stop ${SERVICE_NAME}

# Extract backup
echo "Restoring from backup..."
sudo tar -xzf $BACKUP_DIR/$backup_file -C $PROJECT_DIR

# Set permissions
echo "Setting permissions..."
sudo chown -R www-data:www-data $PROJECT_DIR/db
sudo chown -R www-data:www-data $PROJECT_DIR/media

# Start Gunicorn
echo "Starting Gunicorn..."
sudo systemctl start ${SERVICE_NAME}

echo ""
echo "================================"
echo "Restore Complete!"
echo "================================"
echo ""
echo "Your site has been restored from: $backup_file"
echo ""

