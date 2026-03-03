#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Wukong Bot 部署脚本${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}错误: $1 未安装${NC}"
        exit 1
    fi
}

check_command bun
check_command git

echo -e "${YELLOW}[1/6] 检查环境...${NC}"
bun --version
echo ""

if [ ! -f ".env" ]; then
    echo -e "${RED}错误: .env 文件不存在${NC}"
    echo -e "${YELLOW}请复制 .env.example 并配置你的环境变量${NC}"
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${GREEN}已创建 .env 文件，请编辑它${NC}"
    fi
    exit 1
fi

echo -e "${YELLOW}[2/6] 拉取最新代码...${NC}"
if [ -d ".git" ]; then
    git pull || echo "不是 git 仓库或拉取失败，跳过"
fi
echo ""

echo -e "${YELLOW}[3/6] 安装依赖...${NC}"
bun install
echo ""

echo -e "${YELLOW}[4/6] 检查数据库目录...${NC}"
mkdir -p data logs
echo ""

echo -e "${YELLOW}[5/6] 停止旧服务...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 stop wukong-bot 2>/dev/null || true
    pm2 delete wukong-bot 2>/dev/null || true
fi
echo ""

echo -e "${YELLOW}[6/6] 启动服务...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 start ecosystem.config.cjs
    echo -e "${GREEN}服务已通过 PM2 启动${NC}"
    echo ""
    pm2 save
    echo ""
    pm2 status
else
    echo -e "${YELLOW}PM2 未安装，使用前台模式启动${NC}"
    echo -e "${YELLOW}按 Ctrl+C 停止服务${NC}"
    echo ""
    bun run start
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
