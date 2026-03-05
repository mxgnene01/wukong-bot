# Wukong Bot v2.1 — 自主进化的飞书 AI Agent

<p align="center">
  <strong>飞书机器人 × Claude Code CLI × 自我进化引擎</strong><br/>
  一个运行在本地机器上的全权限 AI 数字员工，具备<b>自主执行</b>、<b>长期记忆</b>与<b>自我进化</b>能力。
</p>

> 架构设计参考 [bytedance/deer-flow](https://github.com/bytedance/deer-flow) · 认知循环灵感来自 [OpenClaw](https://github.com/anthropics/anthropic-cookbook)
>
> **WebSocket 长连接模式**支持，无需内网穿透即可本地开发！

---

## 目录

- [概述](#概述)
- [核心能力](#核心能力)
- [系统架构](#系统架构)
- [架构图](#架构图)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [使用指南](#使用指南)
- [扩展开发](#扩展开发)
- [部署与运维](#部署与运维)
- [数据库设计](#数据库设计)
- [注意事项](#注意事项)
- [License](#license)

---

## 概述

Wukong Bot 不是一个普通的聊天机器人，而是一个**运行在你本地机器上的全权限 AI Agent**。它通过飞书消息接收指令，调用 Claude Code CLI 执行任务，拥有与开发者完全相同的操作系统权限——可以读写文件、执行命令、操作 Git、部署服务。

更重要的是，Wukong Bot 具备**自我进化能力**：它会在完成复杂任务后自动总结经验、生成可复用的技能文件；通过 ThinkingClock 后台巡检器定期策展记忆；通过 Evaluator 元认知循环反思每次执行的质量。随着使用时间增长，Bot 会变得越来越"聪明"。

### 技术栈

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Bun | 高性能 TypeScript 运行时，内置 SQLite/WebSocket |
| AI 引擎 | Claude Code CLI | Anthropic 的 CLI Agent，支持 stream-json 流式输出 |
| 模型代理 | 字节跳动 Ark API | 本地代理转发，兼容 Anthropic 图片格式 |
| 消息通道 | 飞书 WebSocket / Webhook | 双模网关，WebSocket 无需内网穿透 |
| 持久化 | SQLite (bun:sqlite) | 任务队列、会话、记忆、定时任务、工作流状态 |
| 进程管理 | PM2 | 生产环境部署与守护 |

### 代码规模

- **源码**：~11,000 行 TypeScript（30+ 模块）
- **核心文件**：`executor.ts`（863 行）、`workflow/engine.ts`（570 行）、`long_term_memory.ts`（488 行）

---

## 核心能力

### 1. 通信与交互（Senses）

**双模消息网关** — 支持两种事件源接入飞书：

- **WebSocket 长连接**（推荐）：基于 `@larksuiteoapi/node-sdk` 的 WSClient，无需公网 IP 或内网穿透，开箱即用于本地开发。消息通过飞书官方 WebSocket 通道实时推送，延迟 < 100ms。
- **Webhook 回调**：标准 HTTP POST 方式，适用于生产环境部署。内置 Express/Hono 网关层，支持事件签名验证。

**飞书富文本交互**：
- **智能卡片**：长任务自动显示带进度条的交互卡片（Pending → Processing → Completed/Failed），使用基于指数曲线的进度估算器实现平滑推进（40% → 95%）。
- **Markdown 渲染**：完整支持代码块（语法高亮）、列表、表格、加粗/斜体等格式。针对飞书卡片的 Markdown 换行兼容性做了专项适配。
- **纯文本智能切换**：简短回复自动使用 reply 模式（减少一次 API 调用），复杂回复使用卡片模式。

**Typing 指示器**：
- 基于飞书表情 Reaction API 实现 "正在输入" 动画效果。
- 10 秒 keepalive 刷新机制保持可见性（相比初始 3 秒方案减少 ~70% API 调用）。
- 内置限流熔断（支持 429 / 99991400 / 99991403 错误码自动退避）。

### 2. 大脑与执行（Brain & Hands）

**Claude Code CLI 封装**（`src/agent/index.ts`）：
- **全权限终端执行**：Bot 运行在你的机器上，拥有和你一样的操作系统权限。它可以执行 `git pull`、`npm install`、修改代码文件、重启服务——没有沙箱限制。
- **stream-json 流式解析**：实时解析 CLI 的 `--output-format stream-json` 输出，提取思考过程、工具调用、最终回复。三层结果提取防御机制确保回复不丢失。
- **Session 复用**：记录 Claude CLI 的 Session ID，后续对话通过 `--resume` 复用上下文，节省 ~3000-5000 tokens/轮。
- **本地代理模式**：内置 Express 代理服务器将 Anthropic 格式请求转发到字节跳动 Ark API，支持图片 Base64 格式自动转换。

**四级任务分类**（`src/worker/executor.ts`）：

| 级别 | 类型 | System Prompt | Evaluator | 典型场景 |
|------|------|---------------|-----------|----------|
| L0 | `greeting` | 无需 CLI | 跳过 | "你好"、"谢谢" |
| L1 | `simple` | 轻量（Soul 人格） | 跳过 | "今天星期几" |
| L2 | `chat` | 中等（人格 + 用户画像 + 记忆） | 跳过 | "我叫 Alice，负责测试" |
| L3 | `complex` | 完整（全部工具文档） | 启用 | "帮我写一个 API 模块" |

**任务队列**（`src/queue/index.ts`）：
- 基于 SQLite 的持久化任务队列，支持并发控制（默认 3 个 worker）。
- 崩溃恢复：服务重启后自动捞取 `pending` 状态的任务继续执行。
- AbortController 信号传递，支持用户级任务取消。

### 3. 记忆系统（Memory）

Wukong Bot 实现了三层记忆架构，确保 AI 对用户的理解随时间持续加深：

**短期记忆 — Context Window**（`src/session/index.ts`）：
- 维护最近 N 轮对话上下文（可配置），通过 Claude CLI Session 机制实现连续对话。
- Session Key 设计：`{userId}:{chatId}` 确保同一用户在不同群聊中有独立上下文。

**长期记忆 — LTM + UserProfile**（`src/session/long_term_memory.ts`）：
- **智能去抖提取**：消息入队后等待 30 秒（debounce），将多条消息合并成一次 LLM 调用提取记忆，减少 API 成本。
- **即时提取快通道**：检测到自我介绍类消息（包含"我叫"/"部门"/"负责"等关键词）时，绕过 debounce 立即触发记忆提取，确保个人信息不丢失。
- **结构化存储**：提取 UserContext（工作/个人/当前关注）+ UserProfile（姓名/角色/技术栈/项目/沟通风格）+ Facts（事实列表，含置信度评分）。
- **用户画像文件**：每个用户在 `workspace/users/{openId}.md` 有独立的 Markdown 画像文件，格式化后注入 System Prompt。

**身份认知 — Soul System**（`src/soul/index.ts`）：
- 对标 OpenClaw 的 SOUL.md 设计：每个 Agent 有独立的灵魂文件，定义核心人格、使命、行为约束。
- 支持 `[UPDATE_SOUL]` 指令让 Agent 自主修改自己的灵魂。
- ThinkingClock 每次 tick 自动重读 Soul 文件，保持人格一致性。

**Daily Log**（`src/workspace/daily-log.ts`）：
- 每天一个 Markdown 文件（`workspace/memory/YYYY-MM-DD.md`），Append-only。
- 记录对话摘要、关键决策、学到的信息。
- Heartbeat 策展机制将重要信息提炼进 Soul.memories。

### 4. 技能与进化（Skills & Evolution）

这是 Wukong Bot 最核心的差异化能力——使其具备**自我成长**的闭环：

**动态技能加载**（`src/skills/loader/index.ts`）：
- 使用 `fs.watch` 监听 `workspace/skills/` 目录。一旦有新文件生成、修改或删除，**无需重启服务**，Bot 立即学会/更新/遗忘对应技能。
- 支持多种触发方式：命令触发（`/deploy`）、关键词触发（"部署"）、正则触发。
- 技能文件是纯 Markdown 格式，对版本控制友好。

**元学习 — Meta-Learning**（`src/evolution/index.ts`）：
- 当 Bot 解决了一个复杂问题（如"部署流程"），Evaluator 会判断是否值得沉淀为技能。
- 如果判定 `actionType: 'create_skill'`，Evolution Engine 自动调用 LLM 生成 SkillSpec → 写入 `workspace/skills/` → 技能即时生效。
- **教学闭环**：用户教一遍 → Bot 自动总结 → 生成 Skill 文件 → 下次直接调用。

**Evaluator 元认知循环**（`src/reflection/evaluator.ts`）：
- 仅对 `complex` 级别任务启用（`chat`/`simple`/`greeting` 跳过，避免无谓开销）。
- 三级评估：确定性检查（执行成功/失败）→ 启发式检查（JSON 格式/文件存在性）→ LLM 深度评估。
- 评估结果包含 score、critique、insight、actionType，一次 LLM 调用完成全部分析。
- `chat` 和 `simple` 任务使用 fire-and-forget 模式，不阻塞用户回复。

**ThinkingClock 后台巡检**（`src/clock/index.ts`）：
- 每小时自动执行一次后台循环（可配置）。
- 扫描未处理的 Evaluator actionable_item 并执行（创建技能/更新记忆）。
- Heartbeat 策展：DailyLog → Soul.memories 的自动提炼。

### 5. 多智能体协作（Multi-Agent Collaboration）

混合架构："确定性工作流编排 + 动态 Agent 通信"。

**Agent 注册表**（`src/workspace/agents.ts`）：
- `workspace/agents/` 目录下每个 Agent 一个 **`.md` 文件**（扁平结构，非子文件夹）
- 文件名即 Agent ID，如 `workspace/agents/tester.md` → Agent ID 为 `tester`
- 内置 `main`（通用 Agent），可扩展 `programmer`、`reviewer`、`tester` 等角色
- 每个 Agent 拥有独立 System Prompt、能力集和工具白名单

**Agent 文件格式**（Frontmatter + Markdown Sections）：

```markdown
---
name: "资损测试工程师"
description: "专注于资损场景的测试 Agent"
capabilities: [完整测试框架, 用户思维测试, 资损风险评估, 边界条件覆盖]
maxTurns: 15
tools: [Bash, Read, Write, Glob, Grep]
---

## System Prompt

你是一名资深的资损测试工程师，拥有以下核心技能：

1. **完整测试框架**：从 0 到 1 搭建测试体系（单元/集成/E2E）
2. **用户思维**：站在用户角度设计测试场景，覆盖真实使用路径
3. **资损防控**：重点关注金额计算、并发扣款、退款逆向等高危场景
4. **边界覆盖**：系统性枚举边界条件（空值、超限、并发、幂等性）

收到测试任务时，先分析需求文档 → 输出测试矩阵 → 逐一编写测试用例。

## Communication Rules

- 收到编码任务后，先输出测试计划摘要，等待确认后再执行
- 发现潜在资损风险时，立即标记 [RISK] 并通知 main Agent
- 测试完成后，输出覆盖率报告和风险评估矩阵
```

**Agent 配置字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Agent 显示名称 |
| `description` | string | 是 | 职责描述，用于 Agent 目录展示和任务路由 |
| `capabilities` | string[] | 否 | 能力标签列表，用于任务匹配 |
| `maxTurns` | number | 否 | 最大对话轮数，默认 10 |
| `tools` | string[] | 否 | 允许使用的工具白名单（Bash/Read/Write/Glob/Grep 等） |

**Agent 调度机制**：

```
用户请求 → Main Agent 分析任务复杂度
                ↓
        ┌── greeting/simple → 快速回复（不调 CLI）
        ├── chat → 精简 prompt 执行
        └── complex → 完整工具集 + 元认知循环
                ↓
        ┌── 单 Agent 任务 → 路由到对应 Agent（tester/programmer/reviewer）
        └── 复合任务 → 触发工作流编排（多 Agent 协作 DAG）
                          ↓
                  step1: programmer → 编码实现
                  step2: reviewer   → 代码审查（依赖 step1）
                  step3: tester     → 测试验证（依赖 step1）
                  step4: main       → 汇总报告（依赖 step2 + step3）
```

**Agent 间通信**：
- 基于 `agent_messages` 表的异步消息传递（fromSession → toSession）
- 每条消息包含 `correlationId`，支持请求-响应配对
- Agent 可通过 `formatAgentDirectory()` 查看系统中所有可用 Agent
- 通过 `AGENT_SEND` 结构化指令在对话中委派任务给其他 Agent

**创建 Agent 的方式**：

| 方式 | 说明 | 状态 |
|------|------|------|
| 手动创建文件 | 在 `workspace/agents/` 下新建 `.md` 文件 | ✅ 已支持 |
| API 调用 | `AgentsManager.registerAgent(agentId, content)` | ✅ 已支持 |
| 飞书聊天创建 | 如 "创建一个 tester Agent，角色是资损测试工程师" | 🚧 规划中 |

> **注意**：当前版本的 `registerAgent()` API 已可用于程序化创建 Agent，但尚无飞书聊天交互式创建的命令处理器。该功能在规划中，未来版本将支持自然语言驱动的 Agent 创建。


### 6. 定时任务与提醒（Cron）

- 自然语言解析：用户发送"每天早上 9 点提醒我 xxx"，自动解析为 cron 表达式。
- 支持 `[SCHEDULE_TASK]` 指令由 Claude 自主创建定时任务。
- 一次性延时提醒和周期性循环任务均支持。
- 持久化到 SQLite，服务重启后自动恢复调度。

### 7. 安全与确认（Safety）

- **危险操作拦截**（`src/confirmation/index.ts`）：检测 `rm -rf`、`git push --force`、`DROP TABLE` 等高危命令，自动弹出确认卡片。
- **SAFETY_PROMPT**：注入安全指令，约束 Claude 的行为边界。
- **权限跳过优化**：`greeting` 和 `simple` 任务不注入 SAFETY_PROMPT，减少噪音。

### 8. 可观测性（Observability）

- **多级日志**（`src/utils/logger.ts`）：debug / log / info / warn / error 五级，同时输出到控制台和日期轮转文件（`workspace/logs/YYYY-MM-DD.log`）。
- **Token 使用统计**（`src/stats/`）：每日自动统计 input/output tokens、缓存命中率、任务数量，支持飞书卡片推送。
- **Session 录制**（`src/session/recorder.ts`）：记录每轮对话的完整上下文（用户输入 + AI 输出 + 元数据）。
- **精简日志**：WebSocket → Adapter → Main → Middleware 四层链路均已优化为 1 行摘要日志（事件 ID + 消息 ID），避免重复打印完整 JSON。

---

## 系统架构

Wukong Bot 的架构遵循 **Gateway-Worker 分离模式**（参考 deer-flow），核心数据流如下：

```
用户(飞书) → 消息网关(WebSocket/Webhook) → 中间件流水线 → SQLite 任务队列 → Worker 执行引擎
                                                                                      ↓
                                                                              ┌── 记忆系统(LTM + UserProfile + Soul)
                                                                              ├── 技能注册表(动态加载)
                                                                              ├── Agent 注册表(多角色)
                                                                              └── Claude Code CLI(全权限执行)
                                                                                      ↓
                                                                              流式响应 → 飞书卡片/文本 → 用户
                                                                                      ↓
                                                                              Evaluator 元认知 → Evolution → 技能沉淀
```

**模块职责划分**：

| 层级 | 模块 | 职责 |
|------|------|------|
| **接入层** | `lark/ws.ts`, `lark/webhook.ts` | 接收飞书事件，标准化为统一格式 |
| **适配层** | `lark/adapter.ts` | 事件格式归一化（WebSocket / Webhook → `LarkMessageEvent`） |
| **中间件** | `middleware/` | 去重检查 → 会话管理 → 上下文构建，Pipeline 模式 |
| **调度层** | `queue/`, `worker/` | 持久化任务队列 + 并发 Worker 引擎 |
| **执行层** | `worker/executor.ts` | 任务分级、Prompt 构建、CLI 调用、结果处理 |
| **AI 层** | `agent/index.ts` | Claude Code CLI 生命周期管理、stream-json 解析 |
| **认知层** | `reflection/`, `evolution/`, `clock/` | 元认知评估 → 技能进化 → 后台策展 |
| **记忆层** | `session/`, `soul/`, `workspace/` | 三层记忆 + Soul 人格 + Daily Log |
| **通信层** | `lark/client.ts`, `cards/` | 飞书 API 封装、智能卡片模板 |
| **编排层** | `workflow/` | 确定性工作流引擎、多 Agent 协作 |

---

## 架构图

### 核心数据流

```mermaid
graph TD
    User["👤 用户 (飞书)"] -->|发送消息| Gateway["📡 消息网关<br/>WebSocket / Webhook"]
    Gateway --> Adapter["🔄 事件适配器"]
    Adapter --> MW["⚡ 中间件流水线<br/>去重 → 会话 → 上下文"]
    MW -->|入队| Queue["📋 SQLite 任务队列"]
    
    Queue --> Worker["🏭 Worker 执行引擎"]
    
    subgraph "🧠 大脑 (Brain)"
        Worker -->|"L0-L3 分级"| Executor["任务执行器"]
        Executor -->|加载记忆| Memory["记忆系统<br/>LTM + UserProfile"]
        Executor -->|匹配技能| Skills["技能注册表"]
        Executor -->|加载人格| Soul["Soul 系统"]
        Executor -->|构造 Prompt| CLI["Claude Code CLI"]
    end
    
    subgraph "🔄 进化循环 (Evolution Loop)"
        CLI -->|执行结果| Evaluator["Evaluator 元认知"]
        Evaluator -->|"actionType: create_skill"| Evolution["进化引擎"]
        Evolution -->|写入| SkillFiles["workspace/skills/*.md"]
        SkillFiles -->|"fs.watch 热加载"| Skills
        Evaluator -->|"actionType: update_memory"| Memory
    end

    subgraph "⏰ 后台循环 (Background)"
        Clock["ThinkingClock<br/>每小时"] -->|执行待处理 Action| Evolution
        Clock -->|Heartbeat 策展| DailyLog["Daily Log<br/>workspace/memory/"]
        DailyLog -->|提炼| Soul
    end

    CLI -->|"stream-json 流式输出"| Card["📱 飞书卡片/文本"]
    Card --> User
    
    style User fill:#e1f5fe
    style CLI fill:#fff3e0
    style Evolution fill:#e8f5e9
    style Clock fill:#f3e5f5
```

### 多智能体工作流

```mermaid
sequenceDiagram
    participant User as 👤 用户
    participant GW as 📡 Gateway
    participant WF as 🎯 Workflow Engine
    participant P as 💻 Programmer
    participant R as 🔍 Reviewer
    participant T as 🧪 Tester

    User->>GW: /workflow code-review --task "Add Auth"
    GW->>WF: Start Workflow
    
    rect rgb(200, 220, 240)
        Note over P: Step 1: 编码 (TDD Skill)
        WF->>P: Execute Task
        P-->>WF: Code + Tests Created
    end

    loop Code Review 循环
        rect rgb(220, 240, 200)
            Note over R: Step 2: 审查
            WF->>R: Review Code
            alt 通过
                R-->>WF: ✅ Approved
            else 驳回
                R-->>WF: ❌ Feedback
                WF->>P: Fix Issues
            end
        end
    end

    rect rgb(240, 200, 220)
        Note over T: Step 3: 测试
        WF->>T: Run Tests
        T-->>WF: ✅ All Passed
    end

    WF->>User: 📬 Notify Completion
```

### 记忆系统架构

```mermaid
graph LR
    subgraph "输入"
        Msg["用户消息"]
    end
    
    subgraph "短期记忆"
        Session["Session Context<br/>最近 N 轮对话"]
    end
    
    subgraph "长期记忆"
        LTM["LTM 提取器<br/>(30s debounce)"]
        Fast["快通道<br/>(个人信息即时提取)"]
        UP["UserProfile<br/>姓名/角色/技术栈/项目"]
        UC["UserContext<br/>工作/个人/当前关注"]
        Facts["Facts 列表<br/>(含置信度评分)"]
    end
    
    subgraph "身份认知"
        Soul2["Soul.md<br/>核心人格"]
        DL["Daily Log<br/>每日记录"]
    end
    
    Msg --> Session
    Msg -->|普通消息| LTM
    Msg -->|"含'我叫/部门/负责'"| Fast
    LTM --> UP
    LTM --> UC
    LTM --> Facts
    Fast --> UP
    DL -->|"Heartbeat 策展"| Soul2
    
    Session -->|注入 Prompt| CLI2["Claude CLI"]
    UP -->|注入 Prompt| CLI2
    Soul2 -->|注入 Prompt| CLI2
```

---

## 项目结构

```
wukong-bot/
├── src/                          # 源码 (~11,000 行 TypeScript)
│   ├── index.ts                  # 主入口：启动 Gateway + Worker + Cron + Clock
│   ├── gateway.ts                # Gateway 独立启动入口
│   ├── worker.ts                 # Worker 独立启动入口
│   │
│   ├── config/                   # 配置系统
│   │   ├── schema.ts             # 配置 Schema + 环境变量映射 + 验证
│   │   └── index.ts              # 配置加载器
│   │
│   ├── lark/                     # 飞书通信层
│   │   ├── ws.ts                 # WebSocket 长连接事件源
│   │   ├── webhook.ts            # Webhook 事件源
│   │   ├── adapter.ts            # 事件格式归一化
│   │   ├── client.ts             # 飞书 API 客户端（发送消息/卡片/文件）
│   │   ├── typing.ts             # Typing 指示器（表情 Reaction + Keepalive）
│   │   ├── file.ts               # 文件上传/下载（图片识别支持）
│   │   └── eventsource.ts        # 事件源接口定义
│   │
│   ├── middleware/                # 中间件 Pipeline
│   │   ├── index.ts              # Pipeline 编排
│   │   ├── duplicate_check.ts    # 消息去重（事件 ID + 时间窗口）
│   │   ├── session_manager.ts    # 会话管理（创建/复用 Session）
│   │   ├── context_builder.ts    # 上下文构建（解析消息体/附件/引用）
│   │   └── types.ts              # 中间件类型定义
│   │
│   ├── queue/                    # 任务队列
│   │   └── index.ts              # SQLite 持久化队列 + 并发控制
│   │
│   ├── worker/                   # Worker 执行引擎
│   │   ├── index.ts              # Worker 启动/停止
│   │   ├── engine.ts             # 引擎核心：轮询队列 + 分发任务
│   │   └── executor.ts           # ⭐ 核心执行器 (863 行)：任务分级/Prompt 构建/CLI 调用
│   │
│   ├── agent/                    # Claude Code CLI 代理
│   │   ├── index.ts              # CLI 生命周期：spawn → stream-json 解析 → 结果提取
│   │   ├── session.ts            # Session ID 管理（生成/复用/清理）
│   │   ├── stream.ts             # 流式输出处理
│   │   └── command-parser.ts     # Agent 指令解析（AGENT_SEND/TASK_DONE/SCHEDULE_TASK 等）
│   │
│   ├── session/                  # 会话与记忆
│   │   ├── index.ts              # SessionManager：Session 生命周期
│   │   ├── memory.ts             # MemoryManager：记忆系统聚合层
│   │   ├── long_term_memory.ts   # ⭐ LTM 提取器 (488 行)：去抖/即时/结构化提取
│   │   └── recorder.ts           # SessionRecorder：对话录制
│   │
│   ├── soul/                     # Soul 系统 (对标 OpenClaw SOUL.md)
│   │   └── index.ts              # Soul 加载/解析/更新/持久化
│   │
│   ├── skills/                   # 技能系统
│   │   ├── index.ts              # 初始化 + 内置技能注册
│   │   ├── registry.ts           # InMemorySkillRegistry：匹配/注册/查询
│   │   ├── types.ts              # Skill/SkillTrigger/SkillMatch 类型
│   │   ├── builtins/             # 内置技能（Meta-Learning 等）
│   │   └── loader/               # ⭐ 动态加载器：fs.watch 热加载 Markdown 技能文件
│   │
│   ├── reflection/               # 元认知系统
│   │   ├── index.ts              # Reflection 聚合层
│   │   └── evaluator.ts          # TaskEvaluator：三级评估 + 行动建议
│   │
│   ├── evolution/                # 进化引擎
│   │   ├── index.ts              # EvolutionEngine：能力获取 + 洞察进化
│   │   ├── skill-manager.ts      # SkillManager：技能文件 CRUD
│   │   └── cli.ts                # CLI 工具
│   │
│   ├── clock/                    # ThinkingClock 后台巡检
│   │   └── index.ts              # 定时循环：执行待处理 Action + Heartbeat 策展
│   │
│   ├── workflow/                 # 工作流引擎
│   │   ├── engine.ts             # ⭐ WorkflowEngine (570 行)：编排/执行/状态管理
│   │   └── types.ts              # WorkflowDefinition/Step/Run 类型
│   │
│   ├── workspace/                # Workspace 管理
│   │   ├── index.ts              # Workspace 初始化
│   │   ├── agents.ts             # AgentsManager：多 Agent 注册表
│   │   ├── daily-log.ts          # DailyLogManager：每日记录
│   │   ├── user.ts               # UserProfileManager：用户画像文件
│   │   └── semantic-search.ts    # 语义搜索
│   │
│   ├── cards/                    # 飞书卡片模板
│   │   └── index.ts              # Welcome/Progress/Result/Error/Stats 卡片
│   │
│   ├── cron/                     # 定时任务
│   │   ├── index.ts              # Cron 调度器
│   │   └── parser.ts             # 自然语言 → Cron 表达式解析
│   │
│   ├── confirmation/             # 危险操作确认
│   │   └── index.ts              # 模式检测 + 确认卡片
│   │
│   ├── proxy/                    # 本地代理服务器
│   │   └── server.ts             # Anthropic → Ark API 格式转换代理
│   │
│   ├── stats/                    # Token 使用统计
│   │   ├── index.ts              # 统计聚合
│   │   ├── daily.ts              # 每日统计计算
│   │   └── scheduler.ts          # 定时推送调度
│   │
│   ├── db/                       # 数据库层
│   │   ├── index.ts              # SQLite DAO（含表自动迁移）
│   │   └── schema.ts             # 表结构定义
│   │
│   ├── types/                    # 全局类型定义
│   │   └── index.ts              # LarkMessageEvent/ChatContext/QueueTask 等
│   │
│   └── utils/                    # 工具函数
│       ├── logger.ts             # 多级日志 + 日期轮转文件
│       ├── config.ts             # 配置兼容层
│       ├── context.ts            # 上下文工具
│       ├── progress.ts           # 进度管理
│       └── cleanup.ts            # 磁盘清理
│
├── workspace/                    # 运行时数据目录
│   ├── skills/                   # 📂 技能文件（Markdown，fs.watch 热加载）
│   ├── agents/                   # 📂 Agent 定义文件
│   ├── workflows/                # 📂 工作流定义（JSON）
│   ├── souls/                    # 📂 Soul 人格文件
│   ├── memory/                   # 📂 Daily Log（每日一文件）
│   ├── users/                    # 📂 用户画像文件
│   ├── logs/                     # 📂 应用日志（按日期轮转）
│   ├── data/                     # 📂 数据库文件
│   └── images/                   # 📂 用户上传图片缓存
│
├── scripts/                      # 运维脚本
│   ├── deploy.sh                 # PM2 一键部署
│   └── backup.sh                 # 数据库备份
│
├── tests/                        # 测试
│   ├── agent-messaging.test.ts
│   └── workflow-engine.test.ts
│
├── docs/                         # 文档
│   ├── ARCHITECTURE.md           # 架构详细说明
│   ├── FEISHU_PERMISSIONS.md     # 飞书权限配置指南
│   └── multi-agent-collaboration.md
│
├── CLAUDE.md                     # Claude Code CLI 项目指令
├── .env.example                  # 环境变量模板
├── package.json                  # Bun 项目配置
├── tsconfig.json                 # TypeScript 配置
└── ecosystem.config.cjs          # PM2 部署配置
```

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.0.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并配置
- 飞书开放平台应用（需要 Bot 权限）

### 1. 克隆并安装依赖

```bash
git clone <repo-url> wukong-bot
cd wukong-bot
bun install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```bash
# ============ 必填 ============
# 飞书应用凭证（从飞书开放平台获取）
APP_ID=cli_xxxxxx
APP_SECRET=xxxxxxxxxx

# ============ 推荐 ============
# 事件源（二选一）
EVENT_SOURCE=websocket    # 推荐！WebSocket 长连接，无需内网穿透
# EVENT_SOURCE=webhook    # Webhook 模式，需要 ngrok 或公网 IP

# Claude Code CLI 路径（默认在 PATH 中查找）
CLAUDE_CODE_PATH=claude

# 工作目录（存放技能/记忆/日志等，建议使用绝对路径）
WORK_DIR=./workspace

# ============ 可选 ============
# 服务端口（Webhook 模式使用）
PORT=3000

# 日志级别
LOG_LEVEL=info

# 本地代理模式（字节跳动 Ark API）
# ENABLE_LOCAL_PROXY=true
# PROXY_PORT=8080
```

### 3. 配置飞书应用权限

在飞书开放平台为你的应用添加以下权限（详见 `docs/FEISHU_PERMISSIONS.md`）：

| 权限 | 用途 |
|------|------|
| `im:message:send_as_bot` | 发送消息 |
| `im:message` | 接收消息事件 |
| `im:message.reaction:write` | Typing 指示器（表情 Reaction） |
| `im:resource` | 文件/图片上传下载 |
| `im:chat` | 获取群信息 |

### 4. 启动服务

```bash
# 开发模式（推荐，自动热重载）
bun run dev

# 或分别启动 Gateway 和 Worker
bun run gateway   # 仅启动消息网关
bun run worker    # 仅启动任务执行器
```

启动成功后会看到：

```
============================================================
Wukong Bot v2.1.0
============================================================
Environment: development
Event Source: websocket
...
Ready to accept messages!
```

### 5. 验证

在飞书中找到你的 Bot，发送以下消息测试：

| 发送 | 预期行为 |
|------|---------|
| `hello` | 返回 Welcome 卡片 |
| `你好，我是 Alice` | Bot 记住你的名字 |
| `帮我查看 Git 状态` | Bot 执行 `git status` 并返回结果 |
| `统计` | 显示今日 Token 使用统计卡片 |

---

## 配置说明

### 完整环境变量一览

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `APP_ID` | ✅ | — | 飞书应用 ID |
| `APP_SECRET` | ✅ | — | 飞书应用 Secret |
| `EVENT_SOURCE` | — | `webhook` | 事件源：`websocket` 或 `webhook` |
| `CLAUDE_CODE_PATH` | — | `claude` | Claude CLI 可执行文件路径 |
| `WORK_DIR` | — | `./workspace` | 工作目录路径 |
| `PORT` | — | `3000` | HTTP 服务端口 |
| `LOG_LEVEL` | — | `info` | 日志级别：debug/log/info/warn/error |
| `LOG_ENABLE_FILE` | — | `true` | 是否输出日志到文件 |
| `LOG_ENABLE_CONSOLE` | — | `true` | 是否输出日志到控制台 |
| `HEARTBEAT_INTERVAL` | — | `30000` | 心跳间隔（ms） |
| `TASK_TIMEOUT` | — | `1800000` | 任务超时时间（ms，默认 30 分钟） |
| `MAX_CONCURRENT_TASKS` | — | `3` | 最大并发任务数 |
| `ENABLE_LOCAL_PROXY` | — | `false` | 启用本地 API 代理 |
| `PROXY_PORT` | — | `8080` | 代理服务端口 |
| `PM2_NAME` | — | `wukong-bot` | PM2 进程名称 |

---

## 使用指南

### 日常对话

直接在飞书中给 Bot 发消息即可。Bot 会根据消息内容自动分级（L0-L3），选择最合适的处理策略：

- **简单问候**："你好"、"谢谢" → 秒回，不调用 CLI
- **日常聊天**："我叫 Alice，在流量系统团队" → 精简 Prompt，即时记忆提取
- **复杂任务**："帮我写一个用户认证模块" → 完整 Prompt + 进度卡片 + Evaluator

### 技能体系

**查看已有技能**：

```
/skills
```

**教 Bot 新技能**（Meta-Learning 闭环）：

1. 先手动教一遍："帮我执行部署流程：先 `git pull`，然后 `bun install`，最后 `pm2 restart app`。请把这个流程保存为技能 `deploy-app`。"
2. Bot 自动生成 `workspace/skills/deploy-app/` 目录和 Markdown 技能文件。
3. 下次只需发送：`/deploy-app`

**手动创建技能**：

在 `workspace/skills/` 下创建 Markdown 文件：

```markdown
# My Skill

> 这是一个自定义技能


### 技能进化（Self-Evolution）✅ 已实现

Wukong Bot 具备完整的"查找 → 搜索 → 创建"三级技能获取能力，支持用户主动触发和 Reflection 后置触发两种模式。

**完整流程**（v2.1.2）：

```
用户: "帮我创建一个代码审查技能" / "查看当前技能"
                ↓
    ┌─────── SkillRegistry 匹配 ──────┐
    │ 触发词命中 → 匹配到              │
    │ "技能进化" 内置技能              │
    │ → 注入已有技能列表到 prompt      │
    └──────────────────────────────────┘
                ↓
    ┌─────── LLM 自主意图分类 ────────┐
    │ 由 LLM 根据 systemPrompt 自主   │
    │ 判断用户意图属于：              │
    │  · 查询类（列出已有技能）       │
    │  · 学习类（执行三级获取链路）    │
    │  · 混合类（先查 → 没有则学习）  │
    │ 不依赖硬编码关键词匹配          │
    └──────────────────────────────────┘
                ↓
    ┌─────── 三级技能获取链路 ─────────┐
    │                                  │
    │  Step 1: 查找本地 Skills         │
    │  → 扫描 workspace/skills/ 目录   │
    │    ├── 命中 → 直接使用           │
    │    └── 未命中 → Step 2           │
    │                                  │
    │  Step 2: 搜索可复用模板          │
    │  → 项目中搜索 .sh/.py/.md 资源  │
    │    ├── 找到 → 转化为 SKILL.md    │
    │    └── 未找到 → Step 3           │
    │                                  │
    │  Step 3: LLM 自主创建           │
    │  → 生成标准 SKILL.md 并安装     │
    └──────────────────────────────────┘
                ↓
        LLM 携带技能操作结果回复用户
```

**双触发模式**：

| 触发方式 | 入口 | 场景 |
|----------|------|------|
| **主动触发** | `SkillRegistry.match()` → 注入技能列表 → LLM 自主执行 | 用户说"学技能""查看技能""/skills" 等 |
| **被动触发** | `Reflection.analyze()` → `evolveFromInsight()` | 任务完成后 Reflection 评估建议创建新技能 |

**设计原则**（v2.1.2 重构）：

> **触发词只负责"路由到技能进化模块"，意图分类完全交给 LLM。**
>
> 之前版本使用大量硬编码关键词（如"会不会"、"能不能学"、"没有就学"）做意图识别，
> 导致两个问题：(1) 日常对话误触发率高；(2) 无法覆盖用户的自然表达。
> v2.1.2 精简为仅保留**明确意图**的命令和关键词，模糊意图由 LLM systemPrompt 引导自主判断。

**实现细节**：

| 组件 | 文件 | 职责 |
|------|------|------|
| `EvolutionEngine` | `src/evolution/index.ts` | 三级链路编排，返回 `EvolutionResult` |
| `SkillManager` | `src/evolution/skill-manager.ts` | 本地查找 / 市场搜索 / 安装 / 创建 |
| `InMemorySkillRegistry` | `src/skills/registry.ts` | 关键词/正则/命令 触发匹配 |
| `SkillLoader` | `src/skills/loader/index.ts` | 文件监听，自动发现 `SKILL.md` |
| Executor 技能列表注入 | `src/worker/executor.ts` | 匹配到进化技能时，注入已有技能列表 |
| 内置"技能进化"技能 | `src/skills/builtins/index.ts` | 精简触发词 + LLM 引导 systemPrompt |

**`EvolutionResult` 接口**：

```typescript
interface EvolutionResult {
  success: boolean;
  action: 'found_local' | 'installed_market' | 'created_new' | 'failed';
  skillName?: string;
  skill?: Skill;
  message: string;
}
```

**触发词设计**（v2.1.2 精简版）：

| 类型 | 触发词 | 设计原则 |
|------|--------|---------|
| 命令 | `/learn` `/skill` `/skills` `/skill-creator` | 显式命令，零误触发 |
| 关键词 | `学技能` `学习技能` `创建技能` `新技能` `查看技能` `技能列表` | 明确意图，不会与日常对话混淆 |
| 英文 | `create skill` `learn skill` `list skills` `my skills` | 英文用户支持 |

> ⚠️ **不再包含**：`会不会`、`能不能`、`有没有这个能力` 等模糊表达。
> 这些由 LLM 在对话上下文中自然理解，无需通过触发词硬匹配。


## Triggers
- /my-command
- 关键词触发

## System Prompt
你是一个专家，请按照以下步骤执行...
```

保存后**无需重启**，Bot 立即学会。

### 定时任务

```
每天早上 9 点提醒我查看 CI 状态
每周一 10:00 执行代码仓库统计
30 分钟后提醒我开会
```

Bot 会自动解析为 cron 表达式，创建持久化定时任务。

### 记忆管理

```
更新角色定位：你是一个资深后端架构师，专注于分布式系统设计
```

Bot 会保存新的角色定位，后续所有对话都会基于这个定位回复。

### 工作流

工作流（Workflow）是确定性编排器，用于协调多 Agent 完成复杂任务。流程控制（依赖/条件/循环/重试）完全由代码控制，LLM 只负责执行每个步骤。

**触发工作流**：
```
/workflow code-review --task "为 Session 模块添加单元测试"
```

**工作流创建方式**：

工作流通过 JSON 声明式定义，存放在 `workspace/workflows/` 目录下，文件命名为 `*.workflow.json`。

| 创建方式 | 说明 | 状态 |
|----------|------|------|
| 手动编写 JSON | 在 `workspace/workflows/` 下创建 `.workflow.json` | ✅ 已支持 |
| 自然语言生成 | 通过聊天描述自动生成工作流 JSON | 🚧 规划中 |

> 系统启动时通过 `loadWorkflowsFromDir()` 自动扫描加载，运行中新增文件也会被热加载。

**工作流 JSON 结构**：

```json
{
  "id": "code-review",
  "name": "Code Review Pipeline",
  "description": "自动化代码编写、审查与测试流程",
  "steps": [
    {
      "id": "analyze",
      "name": "需求分析",
      "agentId": "main",
      "task": "分析以下需求并输出技术方案：${inputs.task}",
      "dependsOn": []
    },
    {
      "id": "implement",
      "name": "编码实现",
      "agentId": "programmer",
      "task": "基于技术方案进行编码：${steps.analyze.output}",
      "dependsOn": ["analyze"]
    },
    {
      "id": "review",
      "name": "代码审查",
      "agentId": "reviewer",
      "task": "审查代码质量和最佳实践：${steps.implement.output}",
      "dependsOn": ["implement"]
    },
    {
      "id": "test",
      "name": "测试验证",
      "agentId": "tester",
      "task": "编写并运行测试用例：${steps.implement.output}",
      "dependsOn": ["implement"]
    }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 工作流唯一标识 |
| `name` | string | 是 | 工作流显示名称 |
| `description` | string | 否 | 工作流描述 |
| `steps` | Step[] | 是 | 步骤列表 |
| `steps[].id` | string | 是 | 步骤唯一标识 |
| `steps[].name` | string | 是 | 步骤显示名称 |
| `steps[].agentId` | string | 是 | 执行该步骤的 Agent ID |
| `steps[].task` | string | 是 | 步骤提示词，支持模板变量 |
| `steps[].dependsOn` | string[] | 是 | 依赖的步骤 ID 列表（空 = 无依赖，可并行） |
| `steps[].condition` | string | 否 | 条件表达式，满足时才执行 |
| `steps[].loop` | object | 否 | 循环配置 `{ maxIterations, continueIf }` |
| `steps[].timeoutMs` | number | 否 | 步骤超时（默认 300000 = 5分钟） |

**模板变量**：

| 变量格式 | 说明 | 示例 |
|----------|------|------|
| `${inputs.xxx}` | 工作流输入参数 | `${inputs.task}` |
| `${steps.xxx.output}` | 某步骤的输出结果 | `${steps.analyze.output}` |
| `${steps.xxx.status}` | 某步骤的执行状态 | `${steps.review.status}` |
| `${steps.xxx.output.field}` | 步骤结构化输出的深度访问 | `${steps.review.output.approved}` |

**执行流程**：

```
解析 JSON → 构建步骤依赖 DAG
   ↓
找到无依赖步骤 → 并行启动（如 review 和 test 可同时执行）
   ↓
步骤完成 → 解除下游阻塞 → 启动就绪步骤
   ↓
所有步骤完成 → 输出最终结果
   ↓
异常处理：步骤失败 → failFast 模式中止 / 继续执行其余步骤
```


### 每日统计

```
开启每日统计    # 每天 23:00 自动推送统计报告
查看今日统计    # 立即查看当天 Token 消耗
关闭每日统计    # 停止自动推送
```

**统计数据来源**（`src/stats/daily.ts`）：
- 扫描 `workspace/agents/sessions/` 下当日 `.jsonl` 会话文件
- 从 assistant 消息中的 `usage` 字段提取 Token 消耗数据
- 聚合 input_tokens、output_tokens、cache 命中率、总费用

**已知问题与修复**（v2.1.2 ✅ 已修复）：

**根因**：CLI 以 NDJSON（每行一个 JSON 对象）格式输出流数据。`result` 行（包含 `usage` 数据）通常是流的最后一行，由于没有尾部 `\n`，它不会被主循环处理（`buffer = lines.pop()`），而是留在 buffer 中。进程退出后，buffer remainder handler 对这段内容执行 `JSON.parse(buffer)`。但如果 buffer 中包含多行（例如 `partial_json}\n{"type":"result",...}`），`JSON.parse` 会抛异常，而空 `catch(e){}` 直接吞掉错误——tokenUsage 被**静默丢失**。

**修复方案**（两轮修复）：

| 修复 | 位置 | 内容 |
|------|------|------|
| v2.1.1 | Buffer remainder / FullStdout | 增加 tokenUsage 提取逻辑（必要但不充分） |
| **v2.1.2** | **Buffer remainder** | **改为逐行 split + 逐行 parse**，彻底修复多行 buffer 导致 JSON.parse 失败的 bug |

**关键代码**（Buffer remainder v2.1.2 修复）：

```typescript
// 处理 buffer 中剩余的内容（逐行解析，修复多行 buffer 导致 JSON.parse 失败的 bug）
if (buffer.trim()) {
    const remainingLines = buffer.split('\n').filter(line => line.trim());
    for (const line of remainingLines) {
      try {
        const json = JSON.parse(line.trim());
        if (json.type === 'result') {
          if (json.result) resultText = json.result;
          if (json.usage && !tokenUsage) {
            tokenUsage = { /* ... extract fields ... */ };
          }
        }
      } catch (e) {
        logger.debug('[Agent] Buffer remainder - failed to parse line:', line.substring(0, 100));
      }
    }
}
```

**数据流验证**：`Agent.run()` → `tokenUsage` 提取 → `SessionRecorder.recordAssistantMessage(usage)` → JSONL `{ usage: {...} }` → `DailyStats.calculate()` 聚合


---

## 扩展开发

### 添加中间件

```typescript
// src/middleware/my_middleware.ts
import type { Middleware, MiddlewareContext } from './types';

export function createMyMiddleware(): Middleware {
  return {
    name: 'my_middleware',
    priority: 15, // 数字越小越先执行
    async pre(ctx: MiddlewareContext) {
      // 前置处理（在任务入队前）
      if (shouldBlock(ctx)) {
        ctx.stopped = true;
        return;
      }
    },
    async post(ctx: MiddlewareContext) {
      // 后置处理（可选）
    },
  };
}
```

### 添加 Agent 角色

在 `workspace/agents/` 下创建 `.md` 文件（文件名 = Agent ID，扁平结构，不是子文件夹）：

```markdown
---
name: "DevOps 工程师"
description: "专业的 DevOps 自动化工程师"
capabilities: [容器化部署, CI/CD Pipeline, 基础设施即代码, 监控告警]
maxTurns: 20
tools: [Bash, Read, Write]
---

## System Prompt

你是一个专业的 DevOps 工程师，擅长自动化部署、容器编排和基础设施管理。

执行部署操作前，必须：
1. 确认目标环境（dev/staging/prod）
2. 确认版本号和变更内容
3. 检查回滚方案是否就绪

## Communication Rules

- 收到部署请求时，先确认环境和版本号
- 生产环境操作必须通知 main Agent 并等待确认
- 部署完成后输出健康检查报告
```

**常用 Agent 角色参考**：

| Agent | 文件名 | 职责 |
|-------|--------|------|
| Main | `main.md` | 通用助手，任务路由与汇总（内置自动创建） |
| Programmer | `programmer.md` | 编码实现、代码重构 |
| Reviewer | `reviewer.md` | 代码审查、最佳实践建议 |
| Tester | `tester.md` | 测试用例设计与执行 |
| DevOps | `devops.md` | 部署、CI/CD、基础设施 |
| Analyst | `analyst.md` | 数据分析、报表生成 |

创建后 Agent 立即生效（`AgentsManager` 通过文件扫描动态发现），无需重启服务。


### 添加工作流

在 `workspace/workflows/` 下创建 `.workflow.json` 文件，系统自动热加载：

```json
{
  "id": "daily-report",
  "name": "Daily Report Generator",
  "description": "每日自动生成项目进展报告",
  "steps": [
    {
      "id": "collect",
      "name": "收集数据",
      "agentId": "analyst",
      "task": "收集今日的 Git 提交记录、任务完成情况和 Bug 状态：${inputs.project}",
      "dependsOn": []
    },
    {
      "id": "analyze",
      "name": "分析趋势",
      "agentId": "analyst",
      "task": "基于收集的数据分析项目趋势：${steps.collect.output}",
      "dependsOn": ["collect"]
    },
    {
      "id": "report",
      "name": "生成报告",
      "agentId": "main",
      "task": "生成项目日报（关键指标 + 风险提示 + 建议）：${steps.analyze.output}",
      "dependsOn": ["analyze"]
    }
  ]
}
```

**调试技巧**：
1. 确保 `dependsOn` 中引用的步骤 ID 存在且无循环依赖
2. 模板变量 `${inputs.xxx}` 引用输入，`${steps.xxx.output}` 引用步骤输出
3. 工作流执行日志在 `workspace/logs/` 中，搜索 `[WorkflowEngine]` 关键字
4. 无依赖的步骤会被并行执行，合理设计依赖关系可提高效率


## 部署与运维

### PM2 生产部署

```bash
# 一键部署
./scripts/deploy.sh

# 查看状态
pm2 status

# 查看日志
pm2 logs wukong-bot

# 重启
pm2 restart wukong-bot
```

### 数据库备份

```bash
# 手动备份
./scripts/backup.sh

# 备份文件保存在 backups/ 目录
```

### 日志管理

- 日志文件：`workspace/logs/YYYY-MM-DD.log`（按日期自动轮转）
- 日志级别通过 `LOG_LEVEL` 环境变量控制
- 旧日志和缓存文件由 `src/utils/cleanup.ts` 自动清理

### 监控要点

| 指标 | 查看方式 |
|------|---------|
| 服务状态 | `pm2 status` |
| 实时日志 | `pm2 logs wukong-bot` 或 `tail -f workspace/logs/$(date +%Y-%m-%d).log` |
| Token 消耗 | 飞书发送 `统计` 或 `查看今日统计` |
| 任务队列 | SQLite: `SELECT * FROM pending_tasks WHERE status='pending'` |
| 技能列表 | 飞书发送 `/skills` 或 `ls workspace/skills/` |

---

## 数据库设计

使用 SQLite（通过 Bun 内置的 `bun:sqlite`），单文件 `workspace/data/wukong.db`。

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `sessions` | 会话记录 | userId, chatId, claudeSessionId, lastActivity |
| `settings` | KV 配置项 | key, value（含 Agent Identity、UserProfile 等） |
| `pending_tasks` | 持久化任务队列 | id, type, status, context, content, createdAt |
| `scheduled_tasks` | 定时任务 | id, name, cron, content, context, enabled |
| `agent_messages` | Agent 间通信 | fromSession, toSession, message, correlationId |
| `workflow_runs` | 工作流运行状态 | runId, workflowId, status, inputs, results |
| `reflections` | 元认知记录 | taskId, score, critique, insight, actionType |
| `token_usage` | Token 使用记录 | date, inputTokens, outputTokens, costUsd |

---

## 注意事项

1. **安全性**：Bot 拥有本地机器的全部权限，请确保只有可信用户可以与其交互。配合 `confirmation/` 模块对危险操作进行拦截。
2. **并发配置**：多智能体协作会同时启动多个任务，请确保 `MAX_CONCURRENT_TASKS` 至少为 3。
3. **Token 消耗**：复杂任务和工作流会消耗大量 Token，请留意 Claude API 额度。`chat` 级别任务跳过 Evaluator 可节省约 50% 的元认知开销。
4. **磁盘空间**：Daily Log、技能文件、日志会持续增长。`cleanup.ts` 会自动清理过期缓存，但建议定期检查 `workspace/` 目录大小。
5. **Claude CLI 版本**：stream-json 格式依赖 `--verbose` + `--output-format stream-json`，请确保 Claude CLI 版本支持此格式。

---

## License

MIT
