# Wukong Bot v2.1 (自主进化版)

飞书机器人 + Claude Code CLI 系统 —— 一个具备**自主执行**与**自我进化**能力的数字员工。

> 架构设计参考 [bytedance/deer-flow](https://github.com/bytedance/deer-flow)
>
> **WebSocket 长连接模式**支持，无需内网穿透即可本地开发！

## 核心能力 (Key Capabilities)

Wukong Bot 不仅仅是一个聊天机器人，它是一个运行在你本地机器上的全权限 AI Agent。

### 1. 通信与交互 (Senses)
*   **双模网关**：支持 Webhook（生产环境）和 WebSocket（本地开发，无需内网穿透）。
*   **富文本交互**：
    *   **智能卡片**：长任务自动显示进度条卡片（Processing -> Completed/Failed），实时反馈状态。
    *   **Markdown 渲染**：完美支持代码块、列表、加粗等格式，解决了飞书卡片换行渲染的兼容性问题。

### 2. 大脑与执行 (Brain & Hands)
*   **Claude Code CLI 封装**：
    *   **全权限终端**：Bot 运行在你的机器上，拥有和你一样的权限。它可以执行 `git pull`、`npm install`、修改代码文件、重启服务等。
    *   **流式输出**：实时捕获 CLI 的输出流，解析 JSON 格式，实现打字机效果。
*   **任务队列 (Queue)**：
    *   **并发控制**：支持多任务并行处理（默认 3 个并发）。
    *   **持久化与恢复**：任务存储在 SQLite 中。即使服务崩溃重启，未完成的任务也会自动恢复执行，不会丢失。

### 3. 记忆系统 (Memory)
*   **三层记忆架构**：
    1.  **短期记忆 (Context)**：维护最近的对话上下文，支持多轮对话。
    2.  **长期记忆 (Long-term Memory)**：自动提取用户画像、项目背景、偏好设置，持久化到 SQLite。
    3.  **身份认知 (Identity)**：支持动态更新 Bot 的人设（如“你是资深架构师”），并持久化存储。
*   **跨 Session 同步**：实现了 Claude CLI 的 Session ID 管理，确保用户在飞书的连续对话能对应到同一个 CLI 进程上下文。

### 4. 技能与进化 (Skills & Evolution) —— **核心差异化能力**
这是该工程最强大的部分，使其具备了**自我成长**的能力：

1.  **动态技能加载 (Dynamic Skill Loader)**：
    *   **实时生效**：监听 `workspace/skills/*.md` 目录。一旦有新文件生成或修改，无需重启服务，Bot 立即学会新技能。
    *   **热插拔**：删除文件即遗忘技能，修改文件即更新技能。

2.  **元学习 (Meta-Learning)**：
    *   **自我编程**：内置了 `Meta Learning` 系统提示词。当 Bot 解决了一个复杂问题（如“部署流程”），它会**自动**将这个流程总结为一个 Markdown 格式的 Skill 文件，写入 `workspace/skills/`。
    *   **闭环进化**：
        1.  用户教 Bot 做一遍任务。
        2.  Bot 学会并生成 Skill 文件。
        3.  下次用户只需发送指令（如 `/deploy`），Bot 直接调用该 Skill 自动执行。

## 架构概览

```mermaid
graph TD
    User[用户 (飞书)] -->|发送消息| Gateway[消息网关]
    Gateway --> Middleware[中间件流水线]
    Middleware -->|去重/上下文/鉴权| Queue[SQLite 任务队列]
    
    Queue --> Worker[任务执行器]
    
    subgraph "Brain (Local)"
        Worker -->|加载记忆| Memory[记忆系统]
        Worker -->|匹配技能| Skills[技能注册表]
        Worker -->|构造 Prompt| ClaudeCLI[Claude Code CLI]
    end
    
    subgraph "Evolution"
        ClaudeCLI -->|写入| SkillFiles[workspace/skills/*.md]
        SkillFiles -->|监听加载| Skills
    end
    
    ClaudeCLI -->|执行命令| System[操作系统/文件系统]
    ClaudeCLI -->|流式响应| LarkClient[飞书客户端]
    LarkClient -->|更新卡片| User
```

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的配置
```

**关键配置：**
```bash
# 事件源配置 (二选一)
EVENT_SOURCE=websocket  # 推荐！长连接模式，无需内网穿透
# 或
EVENT_SOURCE=webhook    # Webhook 模式，需要 ngrok
```

### 3. 启动服务

```bash
# 开发模式 (Gateway + Worker)
bun run dev

# 生产模式（需要 PM2）
./scripts/deploy.sh

# 也可以分开运行
bun run gateway  # 仅启动 Gateway
bun run worker   # 仅启动 Worker
```

### 4. 体验自主进化

1.  **教学**：对机器人说：“我现在教你一套发布流程：先 `git pull`，然后 `bun install`，最后 `pm2 restart app`。请把这个流程保存为技能 `deploy-app`。”
2.  **生成**：机器人会自动在 `workspace/skills/` 下生成 `deploy-app.md`。
3.  **应用**：下次只需说 `/deploy-app`，机器人即可自动执行全套流程。

## 项目结构

```
src/
├── config/              # 配置系统
├── middleware/          # 中间件管道
├── skills/              # 技能系统 (含 Dynamic Loader)
│   ├── builtins/        # 内置技能 (Meta-Learning)
│   ├── loader/          # 动态加载器
│   └── registry.ts      # 技能注册表
├── gateway/             # Gateway API
├── worker/              # Worker 执行引擎
├── agent/               # Claude Code CLI 代理
├── queue/               # 任务队列
├── db/                  # 数据库层
├── session/             # 会话管理 (Memory System)
├── cards/               # 飞书卡片
├── lark/                # 飞书 API 客户端
├── cron/                # 定时任务
└── docs/                # 文档
```

## 扩展开发

### 添加新的中间件

```typescript
// src/middleware/my_middleware.ts
export function createMyMiddleware(): Middleware {
  return {
    name: 'my_middleware',
    priority: 15,
    async pre(ctx) {
      // 前置处理
    },
  };
}
```

### 手动添加新的技能

除了让机器人自动生成，你也可以手动创建 `.md` 文件到 `workspace/skills/`：

```markdown
# My Skill
> 这是一个手动创建的技能

## Triggers
- /my-command
- 关键词触发

## System Prompt
你是一个专家...
```

## 部署

### 使用 PM2 部署

```bash
# 一键部署
./scripts/deploy.sh

# 查看状态
pm2 status

# 查看日志
pm2 logs wukong-bot
```

### 数据库备份

```bash
./scripts/backup.sh
```

## 数据库表结构

- `sessions`: 会话记录 (含 Claude Session ID)
- `settings`: 配置项 (含 Agent Identity, User Profile)
- `pending_tasks`: 待处理任务（崩溃恢复用）
- `scheduled_tasks`: 定时任务

## License

MIT
