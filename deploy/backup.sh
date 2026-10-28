#!/bin/sh
# Backs up the Team Sync data into ./backups while the server keeps running.
#   backups/current/        latest database + every file content (blobs, copied incrementally)
#   backups/team-sync-YYYY-MM-DD.db   daily database snapshots, kept for KEEP_DAYS days
# Schedule it with cron, e.g.:  15 2 * * *  /opt/team-sync/backup.sh >> /var/log/team-sync-backup.log 2>&1
set -eu
cd "$(dirname "$0")"
KEEP_DAYS="${KEEP_DAYS:-30}"

docker compose exec -T team-sync node --disable-warning=ExperimentalWarning server/dist/cli.js backup /backups/current
cp backups/current/team-sync.db "backups/team-sync-$(date +%F).db"
find backups -maxdepth 1 -name 'team-sync-*.db' -mtime "+$KEEP_DAYS" -delete
echo "$(date -Iseconds) backup ok"
