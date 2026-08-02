#!/usr/bin/env bash
# Zapne nočnú zálohu o 03:00. Spustiť raz na serveri: deploy/install-backup-cron.sh
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/dokladovka}"
BACKUP_DIR="${BACKUP_DIR:-/root/dokladovka-backups}"
LINE="0 3 * * * $PROJECT_DIR/deploy/backup.sh >> $BACKUP_DIR/backup.log 2>&1"

mkdir -p "$BACKUP_DIR"
chmod +x "$PROJECT_DIR/deploy/backup.sh" "$PROJECT_DIR/deploy/restore.sh"

# Riadok sa nikdy nezduplikuje — starý sa najprv odstráni.
( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' || true; echo "$LINE" ) | crontab -
echo "Nočná záloha je zapnutá:"
crontab -l | grep 'deploy/backup.sh'
