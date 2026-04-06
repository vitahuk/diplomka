#!/usr/bin/env bash
set -euo pipefail

# =========================================================
# SQLite weekly backup for Diplomka app
# =========================================================
# Optional env vars:
#   APP_DATA_DIR        Base app data dir (default: /home/vita/diplomka/data)
#   DB_PATH             Full path to sqlite db (default: $APP_DATA_DIR/app.db)
#   BACKUP_DIR          Where backups are stored (default: $APP_DATA_DIR/backups)
#   LOG_DIR             Where logs are stored (default: /home/vita/logs)
#   LOG_FILE            Backup log file (default: $LOG_DIR/sqlite-backup.log)
#   RETENTION_COUNT     Number of newest backups to keep (default: 5)
#   SQLITE_BIN          sqlite3 binary path/name (default: sqlite3)
# =========================================================

APP_DATA_DIR="${APP_DATA_DIR:-/home/vita/diplomka/data}"
DB_PATH="${DB_PATH:-${APP_DATA_DIR}/app.db}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DATA_DIR}/backups}"
LOG_DIR="${LOG_DIR:-/home/vita/logs}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/sqlite-backup.log}"
RETENTION_COUNT="${RETENTION_COUNT:-5}"
SQLITE_BIN="${SQLITE_BIN:-sqlite3}"

mkdir -p "$BACKUP_DIR"
mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

exec >> "$LOG_FILE" 2>&1

log_info() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] $*"
}

log_error() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] $*" >&2
}

cleanup_on_error() {
  local exit_code=$?
  log_error "Backup script failed with exit code ${exit_code}."
  exit "$exit_code"
}
trap cleanup_on_error ERR

log_info "Starting SQLite backup."

if ! command -v "$SQLITE_BIN" >/dev/null 2>&1; then
  log_error "'$SQLITE_BIN' is not installed or not in PATH."
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  log_error "SQLite DB file not found: $DB_PATH"
  exit 1
fi

case "$RETENTION_COUNT" in
  ''|*[!0-9]*)
    log_error "RETENTION_COUNT must be a positive integer."
    exit 1
    ;;
esac

if [ "$RETENTION_COUNT" -lt 1 ]; then
  log_error "RETENTION_COUNT must be >= 1."
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DB_FILE_NAME="$(basename "$DB_PATH")"
DB_BASENAME="${DB_FILE_NAME%.db}"
BACKUP_FILE="${BACKUP_DIR}/${DB_BASENAME}_${STAMP}.sqlite3"
COMPRESSED_BACKUP_FILE="${BACKUP_FILE}.gz"

log_info "DB source: $DB_PATH"
log_info "Backup target: $COMPRESSED_BACKUP_FILE"
log_info "Retention count: $RETENTION_COUNT"

# Consistent snapshot using SQLite online backup API
"$SQLITE_BIN" "$DB_PATH" ".backup '$BACKUP_FILE'"

if [ ! -f "$BACKUP_FILE" ]; then
  log_error "Backup file was not created: $BACKUP_FILE"
  exit 1
fi

gzip -f "$BACKUP_FILE"

if [ ! -f "$COMPRESSED_BACKUP_FILE" ]; then
  log_error "Compressed backup file was not created: $COMPRESSED_BACKUP_FILE"
  exit 1
fi

mapfile -t BACKUPS < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_BASENAME}_*.sqlite3.gz" -printf '%T@ %p\n' \
  | sort -nr \
  | awk '{ $1=""; sub(/^ /, ""); print }'
)

if [ "${#BACKUPS[@]}" -gt "$RETENTION_COUNT" ]; then
  for old_file in "${BACKUPS[@]:$RETENTION_COUNT}"; do
    log_info "Deleting old backup: $old_file"
    rm -f -- "$old_file"
  done
fi

FILE_SIZE="$(du -h "$COMPRESSED_BACKUP_FILE" | cut -f1)"
log_info "Backup created successfully: $COMPRESSED_BACKUP_FILE (size: $FILE_SIZE)"
log_info "SQLite backup finished successfully."