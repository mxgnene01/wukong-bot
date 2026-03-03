#!/bin/bash

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "备份数据库..."
if [ -f "$PROJECT_DIR/data/cody.db" ]; then
    cp "$PROJECT_DIR/data/cody.db "$BACKUP_DIR/cody_$DATE.db
    echo "数据库已备份到: $BACKUP_DIR/cody_$DATE.db"
else
    echo "数据库文件不存在，跳过"
fi

echo "备份 .env 文件..."
if [ -f "$PROJECT_DIR/.env" ]; then
    cp "$PROJECT_DIR/.env "$BACKUP_DIR/env_$DATE.env
    echo ".env 已备份到: $BACKUP_DIR/env_$DATE.env"
fi

echo "清理7天前的备份..."
find "$BACKUP_DIR" -name "*.db" -mtime +7 -delete
find "$BACKUP_DIR" -name "*.env" -mtime +7 -delete

echo "备份完成"
