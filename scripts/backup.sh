#!/bin/bash
set -e

# CONFIGURATION
PROJECT_NAME="'"${PROJECT_NAME}"'"                                    # Project name
PROJECT_DIR="'"${PROJECT_DIR_PATH}"'"                            # Project directory
BACKUP_DIR="'"${BACKUP_DIR_PATH}"'"                         # Backup directory


DATE=$(date +%Y%m%d_%H%M%S)

echo "================================"
echo "${PROJECT_NAME} Backup Script"
echo "================================"

# Create backup directory
sudo mkdir -p $BACKUP_DIR

echo "Creating backup: $DATE"

# Backup database
echo "Backing up database..."
sudo cp $PROJECT_DIR/db/db.sqlite3 $BACKUP_DIR/db_$DATE.sqlite3

# Backup media files
echo "Backing up media files..."
sudo tar -czf $BACKUP_DIR/media_$DATE.tar.gz -C $PROJECT_DIR media/

# Backup .env file
echo "Backing up environment configuration..."
sudo cp $PROJECT_DIR/.env $BACKUP_DIR/env_$DATE.txt

# Create a full backup archive
echo "Creating full backup archive..."
sudo tar -czf $BACKUP_DIR/full_backup_$DATE.tar.gz \
    -C $PROJECT_DIR \
    db/ \
    media/ \
    .env

# Remove backups older than 30 days
echo "Cleaning old backups (older than 30 days)..."
sudo find $BACKUP_DIR -type f -mtime +30 -delete

# List current backups
echo ""
echo "================================"
echo "Current Backups:"
echo "================================"
sudo ls -lh $BACKUP_DIR/

echo ""
echo "Backup complete!"
echo "Backup location: $BACKUP_DIR"
echo "
