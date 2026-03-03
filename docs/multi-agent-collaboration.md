# 功能增强设计文档

**日期**: 2026-03-03
**版本**: v2.2.0

# 多智能体协作系统实现指南

> **用途**：本文档用于投喂给大模型（Claude Code / Cursor / Windsurf 等），指导其在现有 wukong-bot 框架上实现多 Agent 协作能力。
>
> **项目基础**：基于 Claude Code CLI 的飞书 Bot 框架，已具备 SQLite 任务队列、Worker 并发引擎、Skill 技能系统。
>
> **参考来源**：OpenClaw 多 Agent 架构（sessions_spawn / sessions_send / agentToAgent / Lobster 工作流引擎）。

---

## 一、项目现状与目标

### 1.1 现有架构

```
飞书消息 → Gateway → Middleware → Queue (SQLite) → Worker Engine → Task Executor → Claude Code CLI
```

**已有能力**：

| 模块 | 文件 | 能力 |
|:------|:------|:------|
| 任务队列 | `src/queue/index.ts` | SQLite 持久化队列，任务状态管理（pending → processing → completed/failed） |
| Worker 引擎 | `src/worker/engine.ts` | 并发控制（maxConcurrentTasks，默认 3），任务轮询与分发 |
| 任务执行器 | `src/worker/executor.ts` | 调用 Claude Code CLI 执行任务，流式输出回飞书 |
| 技能系统 | `src/skills/registry.ts` + `src/skills/types.ts` | 动态加载 .md 技能文件，关键词/指令/正则触发 |
| 数据库 | `src/db/index.ts` | SQLite 操作层，任务 CRUD、心跳更新、故障恢复 |
| 配置 | `src/config/schema.ts` + `src/config/index.ts` | Zod schema 校验，支持 maxConcurrentTasks、heartbeatIntervalMs 等 |

**已有数据库表**：

- `pending_tasks` — 任务队列（id, status, workerId, payload, lastHeartbeatAt, createdAt, updatedAt）

### 1.2 目标能力

实现三层递进的多 Agent 协作能力：

| 阶段 | 能力 | 优先级 |
|:------|:------|:--------|
| **Phase 1** | Agent 间消息通信 — Agent 之间可以发送/接收消息 | P0 必做 |
| **Phase 2** | 确定性工作流编排 — 用 JSON 状态机驱动多 Agent 协作流程 | P0 必做 |
| **Phase 3** | 独立 Agent Profile — 每个 Agent 有独立身份、模型、工具权限、工作目录 | P1 增强 |

### 1.3 设计原则

1. **不要用 LLM 做编排** — LLM 负责创造性工作（写代码、审查、测试），代码负责流程调度
2. **复用已有基础设施** — 尽量在现有 SQLite + Worker 架构上扩展，不引入新的中间件
3. **渐进式改造** — 每个 Phase 独立可交付，不破坏现有单 Agent 功能
4. **Claude Code CLI 是 Agent Runtime** — 不重建工具系统，只补"调度层"和"通信层"

---

## 二、Phase 1：Agent 间消息通信

### 2.1 目标

让多个 Agent Session 之间可以互相发消息，实现：
- Agent A 完成任务后，通知 Agent B 开始工作
- Agent B 可以读取 Agent A 发来的消息和上下文
- 支持同步等待（阻塞直到对方回复）和异步（fire-and-forget）两种模式

### 2.2 数据库改造

**在 `src/db/index.ts` 中新增 `agent_messages` 表**：

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,          -- 发送方 session key，如 "agent:programmer:project-a"
  to_session TEXT NOT NULL,            -- 接收方 session key，如 "agent:reviewer:project-a"
  message TEXT NOT NULL,               -- 消息内容（支持 JSON 格式传递结构化数据）
  message_type TEXT DEFAULT 'text',    -- 消息类型：text / task_result / task_request / status_update
  correlation_id TEXT,                 -- 关联 ID，用于追踪请求-响应对
  status TEXT DEFAULT 'pending',       -- pending / read / expired / failed
  metadata TEXT,                       -- 附加元数据（JSON），如 { "priority": "high", "workflow_id": "xxx" }
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME,
  expires_at DATETIME                  -- 可选过期时间
);

CREATE INDEX idx_agent_messages_to_session ON agent_messages(to_session, status);
CREATE INDEX idx_agent_messages_correlation ON agent_messages(correlation_id);
```

**在 `src/db/index.ts` 中新增操作方法**：

```typescript
// ============================================================
// Agent Messages — Agent 间通信
// ============================================================

export interface AgentMessage {
  id: number;
  fromSession: string;
  toSession: string;
  message: string;
  messageType: 'text' | 'task_result' | 'task_request' | 'status_update';
  correlationId: string | null;
  status: 'pending' | 'read' | 'expired' | 'failed';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  expiresAt: string | null;
}

/**
 * 发送消息给指定 Agent Session
 * 对标 OpenClaw 的 sessions_send()
 */
export function sendAgentMessage(params: {
  fromSession: string;
  toSession: string;
  message: string;
  messageType?: AgentMessage['messageType'];
  correlationId?: string;
  metadata?: Record<string, unknown>;
  expiresInMs?: number;
}): number {
  const {
    fromSession,
    toSession,
    message,
    messageType = 'text',
    correlationId = null,
    metadata = null,
    expiresInMs,
  } = params;

  const expiresAt = expiresInMs
    ? new Date(Date.now() + expiresInMs).toISOString()
    : null;

  const stmt = db.prepare(`
    INSERT INTO agent_messages (from_session, to_session, message, message_type, correlation_id, status, metadata, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const result = stmt.run(
    fromSession,
    toSession,
    message,
    messageType,
    correlationId,
    metadata ? JSON.stringify(metadata) : null,
    expiresAt,
  );

  return result.lastInsertRowid as number;
}

/**
 * 读取发给指定 Agent Session 的未读消息
 * 读取后自动标记为 read
 */
export function readAgentMessages(sessionKey: string, limit = 20): AgentMessage[] {
  // 先清理过期消息
  db.prepare(`
    UPDATE agent_messages SET status = 'expired'
    WHERE to_session = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run(sessionKey);

  // 读取未读消息
  const messages = db.prepare(`
    SELECT * FROM agent_messages
    WHERE to_session = ? AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(sessionKey, limit) as AgentMessage[];

  // 标记为已读
  if (messages.length > 0) {
    const ids = messages.map(m => m.id).join(',');
    db.prepare(`
      UPDATE agent_messages SET status = 'read', read_at = datetime('now')
      WHERE id IN (${ids})
    `).run();
  }

  return messages.map(m => ({
    ...m,
    metadata: m.metadata ? JSON.parse(m.metadata as unknown as string) : null,
  }));
}

/**
 * 等待指定 correlation_id 的回复消息
 * 用于同步模式的 Agent 间通信
 */
export async function waitForReply(
  sessionKey: string,
  correlationId: string,
  timeoutMs = 120_000,
  pollIntervalMs = 1_000,
): Promise<AgentMessage | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reply = db.prepare(`
      SELECT * FROM agent_messages
      WHERE to_session = ? AND correlation_id = ? AND status = 'pending'
      LIMIT 1
    `).get(sessionKey, correlationId) as AgentMessage | undefined;

    if (reply) {
      // 标记为已读
      db.prepare(`
        UPDATE agent_messages SET status = 'read', read_at = datetime('now')
        WHERE id = ?
      `).run(reply.id);

      return {
        ...reply,
        metadata: reply.metadata ? JSON.parse(reply.metadata as unknown as string) : null,
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return null; // 超时
}

/**
 * 列出当前活跃的 Agent Sessions
 * 对标 OpenClaw 的 sessions_list()
 */
export function listActiveSessions(): Array<{ sessionKey: string; lastActiveAt: string; taskCount: number }> {
  return db.prepare(`
    SELECT
      JSON_EXTRACT(payload, '$.sessionKey') as sessionKey,
      MAX(updatedAt) as lastActiveAt,
      COUNT(*) as taskCount
    FROM pending_tasks
    WHERE status IN ('processing', 'pending')
    GROUP BY sessionKey
    ORDER BY lastActiveAt DESC
  `).all() as Array<{ sessionKey: string; lastActiveAt: string; taskCount: number }>;
}
```

### 2.3 Session Key 命名规范

采用类似 OpenClaw 的三段式命名：

```
agent:<agentId>:<context>

示例：
  agent:main:user-12345              ← 主 Agent 处理用户 12345 的会话
  agent:programmer:project-abc       ← 编码 Agent 处理项目 abc
  agent:reviewer:project-abc         ← 审查 Agent 处理项目 abc
  agent:tester:project-abc           ← 测试 Agent 处理项目 abc
  workflow:code-review:run-001       ← 工作流 001 的编排 session
```

**在 `src/queue/index.ts` 或新建 `src/agent/session.ts` 中定义**：

```typescript
// src/agent/session.ts

/**
 * 生成标准化的 Agent Session Key
 */
export function makeSessionKey(agentId: string, context: string): string {
  return `agent:${agentId}:${context}`;
}

/**
 * 解析 Session Key
 */
export function parseSessionKey(key: string): { type: string; agentId: string; context: string } | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  return {
    type: parts[0],       // "agent" 或 "workflow"
    agentId: parts[1],    // "programmer", "reviewer" 等
    context: parts.slice(2).join(':'), // 剩余部分作为 context
  };
}
```

### 2.4 Executor 层改造 — 消息注入

**修改 `src/worker/executor.ts`**，在调用 Claude Code CLI 之前注入收件箱消息：

```typescript
// src/worker/executor.ts

import { readAgentMessages, sendAgentMessage } from '../db/index.js';
import { parseAgentCommands } from '../agent/command-parser.js';

/**
 * 执行单个任务 — 增加 Agent 间通信能力
 */
export async function executeTask(task: PendingTask): Promise<TaskResult> {
  const sessionKey = task.sessionKey || `agent:main:${task.userId}`;

  // ========== 新增：读取收件箱 ==========
  const inboxMessages = readAgentMessages(sessionKey);
  const inboxSection = formatInboxForPrompt(inboxMessages);

  // ========== 新增：构造增强 prompt ==========
  const skill = loadSkill(task);
  const agentToolsSection = `
## Agent 通信工具

你可以与其他 Agent 协作。使用以下格式发送消息：

### 发送消息给其他 Agent
\`\`\`
[AGENT_SEND to="agent:<agentId>:<context>" type="<message_type>"]
消息内容
[/AGENT_SEND]
\`\`\`

参数说明：
- to: 目标 Agent 的 session key
- type: 消息类型，可选值：text（普通消息）、task_result（任务结果）、task_request（任务请求）、status_update（状态更新）

### 标记任务完成
当你完成当前任务时，输出：
\`\`\`
[TASK_DONE status="success"]
任务结果摘要（会传递给下一个 Agent 或返回给用户）
[/TASK_DONE]
\`\`\`

如果任务失败：
\`\`\`
[TASK_DONE status="failed" reason="失败原因"]
错误详情
[/TASK_DONE]
\`\`\`
`;

  const enhancedSystemPrompt = [
    skill?.systemPrompt || '',
    agentToolsSection,
    inboxSection,
  ].filter(Boolean).join('\n\n---\n\n');

  // ========== 调用 Claude Code CLI ==========
  const result = await claudeCodeCLI.execute({
    systemPrompt: enhancedSystemPrompt,
    userMessage: task.userMessage,
    workingDirectory: task.workingDirectory,
    // ... 其他参数
  });

  // ========== 新增：解析输出中的 Agent 通信指令 ==========
  const commands = parseAgentCommands(result.output);

  for (const cmd of commands) {
    if (cmd.type === 'AGENT_SEND') {
      sendAgentMessage({
        fromSession: sessionKey,
        toSession: cmd.to,
        message: cmd.content,
        messageType: cmd.messageType || 'text',
        correlationId: cmd.correlationId,
        metadata: cmd.metadata,
      });
    }
  }

  return {
    output: result.output,
    commands, // 返回解析出的命令，供 Engine 层处理
  };
}

/**
 * 将收件箱消息格式化为 prompt 片段
 */
function formatInboxForPrompt(messages: AgentMessage[]): string {
  if (messages.length === 0) return '';

  const lines = messages.map(m => {
    const from = m.fromSession;
    const time = m.createdAt;
    const type = m.messageType !== 'text' ? ` [${m.messageType}]` : '';
    return `### 来自 ${from}${type}（${time}）\n${m.message}`;
  });

  return `## 📬 收件箱 — 来自其他 Agent 的消息\n\n以下是其他 Agent 发给你的消息，请根据内容决定如何处理：\n\n${lines.join('\n\n---\n\n')}`;
}
```

### 2.5 命令解析器

**新建 `src/agent/command-parser.ts`**：

```typescript
// src/agent/command-parser.ts

export interface AgentCommand {
  type: 'AGENT_SEND' | 'TASK_DONE';
  to?: string;           // AGENT_SEND 的目标
  content: string;       // 消息内容或任务结果
  messageType?: string;  // 消息类型
  correlationId?: string;
  status?: 'success' | 'failed';
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 从 Claude Code CLI 的输出中解析 Agent 通信指令
 *
 * 支持格式：
 *   [AGENT_SEND to="xxx" type="xxx"] content [/AGENT_SEND]
 *   [TASK_DONE status="success"] content [/TASK_DONE]
 */
export function parseAgentCommands(output: string): AgentCommand[] {
  const commands: AgentCommand[] = [];

  // 解析 AGENT_SEND
  const sendRegex = /\[AGENT_SEND\s+([^\]]*)\]([\s\S]*?)\[\/AGENT_SEND\]/g;
  let match: RegExpExecArray | null;

  while ((match = sendRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'AGENT_SEND',
      to: attrs.to,
      content,
      messageType: attrs.type || 'text',
      correlationId: attrs.correlation_id,
    });
  }

  // 解析 TASK_DONE
  const doneRegex = /\[TASK_DONE\s+([^\]]*)\]([\s\S]*?)\[\/TASK_DONE\]/g;

  while ((match = doneRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'TASK_DONE',
      content,
      status: (attrs.status as 'success' | 'failed') || 'success',
      reason: attrs.reason,
    });
  }

  return commands;
}

/**
 * 解析属性字符串，如 'to="xxx" type="yyy"'
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }

  return attrs;
}
```

### 2.6 测试验证

```typescript
// tests/agent-messaging.test.ts

import { describe, it, expect, beforeEach } from 'bun:test';
import { sendAgentMessage, readAgentMessages, waitForReply } from '../src/db/index.js';
import { parseAgentCommands } from '../src/agent/command-parser.js';

describe('Agent Messaging', () => {
  beforeEach(() => {
    // 清空测试数据
    db.prepare('DELETE FROM agent_messages').run();
  });

  it('should send and receive messages between agents', () => {
    // Agent A 发送消息给 Agent B
    const msgId = sendAgentMessage({
      fromSession: 'agent:programmer:project-1',
      toSession: 'agent:reviewer:project-1',
      message: '代码已完成，请审查：\n```\nfunction add(a, b) { return a + b; }\n```',
      messageType: 'task_result',
    });

    expect(msgId).toBeGreaterThan(0);

    // Agent B 读取消息
    const messages = readAgentMessages('agent:reviewer:project-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].fromSession).toBe('agent:programmer:project-1');
    expect(messages[0].messageType).toBe('task_result');

    // 再次读取应该为空（已标记为 read）
    const messagesAgain = readAgentMessages('agent:reviewer:project-1');
    expect(messagesAgain).toHaveLength(0);
  });

  it('should parse AGENT_SEND commands from CLI output', () => {
    const output = `
好的，我已经完成了代码编写。现在通知审查 Agent。

[AGENT_SEND to="agent:reviewer:project-1" type="task_result"]
## 代码变更摘要
- 新增 add() 函数
- 新增单元测试
- 修改了 package.json
[/AGENT_SEND]

[TASK_DONE status="success"]
代码编写完成，已通知 reviewer 进行审查。
[/TASK_DONE]
    `;

    const commands = parseAgentCommands(output);
    expect(commands).toHaveLength(2);
    expect(commands[0].type).toBe('AGENT_SEND');
    expect(commands[0].to).toBe('agent:reviewer:project-1');
    expect(commands[1].type).toBe('TASK_DONE');
    expect(commands[1].status).toBe('success');
  });

  it('should support synchronous wait for reply', async () => {
    const correlationId = 'review-request-001';

    // 模拟异步回复
    setTimeout(() => {
      sendAgentMessage({
        fromSession: 'agent:reviewer:project-1',
        toSession: 'agent:programmer:project-1',
        message: '审查通过，代码质量良好。',
        messageType: 'task_result',
        correlationId,
      });
    }, 500);

    // 等待回复
    const reply = await waitForReply('agent:programmer:project-1', correlationId, 5000);
    expect(reply).not.toBeNull();
    expect(reply!.message).toContain('审查通过');
  });
});
```

---

## 三、Phase 2：确定性工作流编排

### 3.1 目标

实现一个 JSON 驱动的工作流引擎，能够：
- 定义多步骤工作流，指定每步使用哪个 Agent 和 Skill
- 支持步骤间的依赖关系和数据传递
- 支持条件分支和循环（最多 N 次迭代）
- 用代码（非 LLM）控制流程，LLM 只做每一步的具体执行

### 3.2 工作流定义格式

**新建 `src/workflow/types.ts`**：

```typescript
// src/workflow/types.ts

/**
 * 工作流定义 — JSON 格式
 * 设计参考 OpenClaw Lobster 工作流引擎
 */
export interface WorkflowDefinition {
  /** 工作流唯一标识 */
  id: string;

  /** 工作流名称 */
  name: string;

  /** 工作流描述 */
  description?: string;

  /** 输入参数定义 */
  inputs?: Record<string, {
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: unknown;
    description?: string;
  }>;

  /** 工作流步骤 */
  steps: WorkflowStep[];

  /** 全局配置 */
  config?: {
    /** 整个工作流的超时（毫秒） */
    timeoutMs?: number;
    /** 失败时是否中止整个工作流 */
    failFast?: boolean;
    /** 最大重试次数（针对整个工作流） */
    maxRetries?: number;
  };
}

export interface WorkflowStep {
  /** 步骤 ID，在工作流内唯一 */
  id: string;

  /** 步骤名称（用于日志和通知） */
  name: string;

  /** 使用哪个 Agent 执行 */
  agentId: string;

  /** 加载哪个 Skill */
  skillId?: string;

  /** 传递给 Agent 的任务描述 */
  task: string;

  /** 依赖的前置步骤 ID */
  dependsOn?: string[];

  /**
   * 执行条件 — JavaScript 表达式
   * 可引用前置步骤的输出：steps.<stepId>.output, steps.<stepId>.status
   * 示例："steps.review.output.approved === true"
   */
  condition?: string;

  /**
   * 输入映射 — 将前置步骤的输出映射到当前步骤的输入
   * 使用模板变量：${steps.<stepId>.output}, ${inputs.<paramName>}
   */
  input?: string;

  /**
   * 循环配置 — 当前步骤重复执行
   * 用于代码→审查→修改 的迭代循环
   */
  loop?: {
    /** 最大迭代次数 */
    maxIterations: number;
    /**
     * 继续条件 — JavaScript 表达式
     * 返回 true 则继续循环，false 则退出
     * 可引用：iteration（当前迭代次数，从1开始）, lastOutput（上次输出）
     */
    continueIf: string;
  };

  /** 步骤超时（毫秒） */
  timeoutMs?: number;

  /** 步骤失败时的处理策略 */
  onFailure?: 'abort' | 'skip' | 'retry';

  /** 重试次数（仅 onFailure = 'retry' 时有效） */
  maxRetries?: number;
}

/**
 * 工作流运行时状态
 */
export interface WorkflowRun {
  /** 运行 ID */
  runId: string;

  /** 工作流定义 ID */
  workflowId: string;

  /** 运行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** 输入参数 */
  inputs: Record<string, unknown>;

  /** 各步骤的执行结果 */
  steps: Record<string, WorkflowStepResult>;

  /** 创建时间 */
  createdAt: string;

  /** 更新时间 */
  updatedAt: string;

  /** 完成时间 */
  completedAt?: string;

  /** 错误信息 */
  error?: string;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: string;
  structuredOutput?: Record<string, unknown>;
  iteration?: number;  // 当前迭代次数（loop 场景）
  startedAt?: string;
  completedAt?: string;
  error?: string;
  agentSessionKey?: string;
}
```

### 3.3 工作流引擎核心实现

**新建 `src/workflow/engine.ts`**：

```typescript
// src/workflow/engine.ts

import { v4 as uuid } from 'uuid';
import { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepResult } from './types.js';
import { sendAgentMessage, readAgentMessages, waitForReply } from '../db/index.js';
import { makeSessionKey } from '../agent/session.js';
import { enqueueTask } from '../queue/index.js';
import { EventEmitter } from 'events';

/**
 * 工作流引擎 — 确定性编排器
 *
 * 核心设计原则：
 * 1. 编排逻辑是纯代码，不是 LLM
 * 2. LLM（Claude Code CLI）只负责执行每个步骤的具体任务
 * 3. 步骤间的数据传递通过 Agent Messages + 模板变量
 * 4. 循环/条件/依赖全部由引擎控制
 */
export class WorkflowEngine extends EventEmitter {
  private runs: Map<string, WorkflowRun> = new Map();
  private definitions: Map<string, WorkflowDefinition> = new Map();

  /**
   * 注册工作流定义
   */
  registerWorkflow(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * 从 JSON 文件加载工作流定义
   */
  async loadWorkflowsFromDir(dir: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const files = await fs.readdir(dir);

    for (const file of files) {
      if (file.endsWith('.workflow.json')) {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const definition = JSON.parse(content) as WorkflowDefinition;
        this.registerWorkflow(definition);
      }
    }
  }

  /**
   * 启动工作流
   *
   * @param workflowId 工作流定义 ID
   * @param inputs 输入参数
   * @param triggeredBy 触发来源（用户 ID 或系统）
   * @returns 运行 ID
   */
  async startWorkflow(
    workflowId: string,
    inputs: Record<string, unknown>,
    triggeredBy: string,
  ): Promise<string> {
    const definition = this.definitions.get(workflowId);
    if (!definition) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    // 验证必填参数
    if (definition.inputs) {
      for (const [key, schema] of Object.entries(definition.inputs)) {
        if (schema.required && !(key in inputs)) {
          if (schema.default !== undefined) {
            inputs[key] = schema.default;
          } else {
            throw new Error(`Missing required input: ${key}`);
          }
        }
      }
    }

    // 创建运行实例
    const runId = uuid();
    const run: WorkflowRun = {
      runId,
      workflowId,
      status: 'running',
      inputs,
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 初始化所有步骤状态
    for (const step of definition.steps) {
      run.steps[step.id] = {
        stepId: step.id,
        status: step.dependsOn?.length ? 'blocked' : 'pending',
      };
    }

    this.runs.set(runId, run);
    this.persistRun(run);

    this.emit('workflow:started', { runId, workflowId, triggeredBy });

    // 开始执行
    await this.executeReadySteps(runId, definition);

    return runId;
  }

  /**
   * 核心调度循环 — 执行所有就绪的步骤
   *
   * 就绪条件：
   * 1. 状态为 pending
   * 2. 所有 dependsOn 的步骤已 completed
   * 3. condition 条件满足（如果有）
   */
  private async executeReadySteps(runId: string, definition: WorkflowDefinition): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;

    const readySteps = definition.steps.filter(step => {
      const stepResult = run.steps[step.id];
      if (stepResult.status !== 'pending') return false;

      // 检查依赖
      if (step.dependsOn?.length) {
        const allDepsCompleted = step.dependsOn.every(depId => {
          const dep = run.steps[depId];
          return dep && dep.status === 'completed';
        });
        if (!allDepsCompleted) return false;
      }

      // 检查条件
      if (step.condition) {
        try {
          const result = this.evaluateCondition(step.condition, run);
          if (!result) {
            // 条件不满足，跳过
            run.steps[step.id].status = 'skipped';
            run.steps[step.id].completedAt = new Date().toISOString();
            this.emit('step:skipped', { runId, stepId: step.id, reason: 'condition not met' });
            return false;
          }
        } catch (err) {
          // 条件评估失败，跳过
          run.steps[step.id].status = 'failed';
          run.steps[step.id].error = `Condition evaluation failed: ${err}`;
          return false;
        }
      }

      return true;
    });

    // 并行执行所有就绪步骤
    const execPromises = readySteps.map(step => this.executeStep(runId, definition, step));
    await Promise.allSettled(execPromises);
  }

  /**
   * 执行单个工作流步骤
   */
  private async executeStep(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];

    // 标记为运行中
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    stepResult.agentSessionKey = makeSessionKey(step.agentId, `workflow:${runId}:${step.id}`);

    this.emit('step:started', { runId, stepId: step.id, agentId: step.agentId });

    try {
      // 处理循环
      if (step.loop) {
        await this.executeStepWithLoop(runId, definition, step);
      } else {
        await this.executeStepOnce(runId, definition, step);
      }
    } catch (err) {
      stepResult.status = 'failed';
      stepResult.error = String(err);
      stepResult.completedAt = new Date().toISOString();

      this.emit('step:failed', { runId, stepId: step.id, error: String(err) });

      // 处理失败策略
      if (step.onFailure === 'abort' || definition.config?.failFast) {
        run.status = 'failed';
        run.error = `Step ${step.id} failed: ${err}`;
        this.emit('workflow:failed', { runId, error: run.error });
        return;
      }
    }

    this.persistRun(run);

    // 检查是否所有步骤完成
    this.checkWorkflowCompletion(runId, definition);

    // 触发下游步骤（解除阻塞）
    this.unblockDependentSteps(runId, definition, step.id);

    // 继续执行就绪的步骤
    await this.executeReadySteps(runId, definition);
  }

  /**
   * 执行单次步骤（无循环）
   */
  private async executeStepOnce(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];
    const sessionKey = stepResult.agentSessionKey!;

    // 构造任务输入 — 使用模板变量替换
    const taskMessage = this.resolveTemplate(step.task, run);
    const inputData = step.input ? this.resolveTemplate(step.input, run) : undefined;

    // 创建任务并放入队列
    const correlationId = `workflow:${runId}:${step.id}`;

    // 通过任务队列提交给 Worker
    const taskId = enqueueTask({
      sessionKey,
      agentId: step.agentId,
      skillId: step.skillId,
      userMessage: inputData ? `${taskMessage}\n\n---\n\n## 上下文数据\n\n${inputData}` : taskMessage,
      correlationId,
      metadata: {
        workflowId: definition.id,
        runId,
        stepId: step.id,
      },
    });

    // 等待任务完成（通过 Agent Message 回复）
    const reply = await waitForReply(
      `workflow:${runId}`,       // 工作流引擎的 session key
      correlationId,
      step.timeoutMs || 300_000, // 默认 5 分钟超时
    );

    if (!reply) {
      throw new Error(`Step ${step.id} timed out`);
    }

    // 记录结果
    stepResult.status = 'completed';
    stepResult.output = reply.message;
    stepResult.completedAt = new Date().toISOString();

    // 尝试解析结构化输出
    try {
      stepResult.structuredOutput = JSON.parse(reply.message);
    } catch {
      // 非 JSON 输出，保持原样
    }

    this.emit('step:completed', { runId, stepId: step.id, output: reply.message });
  }

  /**
   * 带循环的步骤执行
   * 用于代码→审查→修改 的迭代场景
   */
  private async executeStepWithLoop(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];
    const loop = step.loop!;

    let lastOutput: string | undefined;

    for (let iteration = 1; iteration <= loop.maxIterations; iteration++) {
      stepResult.iteration = iteration;

      this.emit('step:loop-iteration', { runId, stepId: step.id, iteration, maxIterations: loop.maxIterations });

      // 执行一次
      const sessionKey = makeSessionKey(step.agentId, `workflow:${runId}:${step.id}:iter-${iteration}`);
      stepResult.agentSessionKey = sessionKey;

      const correlationId = `workflow:${runId}:${step.id}:iter-${iteration}`;

      // 构造包含迭代上下文的任务
      const iterationContext = lastOutput
        ? `\n\n## 上一轮结果（第 ${iteration - 1} 轮）\n\n${lastOutput}`
        : '';

      const taskMessage = this.resolveTemplate(step.task, run) + iterationContext;

      enqueueTask({
        sessionKey,
        agentId: step.agentId,
        skillId: step.skillId,
        userMessage: taskMessage,
        correlationId,
        metadata: {
          workflowId: definition.id,
          runId,
          stepId: step.id,
          iteration,
        },
      });

      const reply = await waitForReply(
        `workflow:${runId}`,
        correlationId,
        step.timeoutMs || 300_000,
      );

      if (!reply) {
        throw new Error(`Step ${step.id} iteration ${iteration} timed out`);
      }

      lastOutput = reply.message;

      // 检查是否继续循环
      const shouldContinue = this.evaluateLoopCondition(loop.continueIf, {
        iteration,
        lastOutput,
        run,
      });

      if (!shouldContinue) {
        break;
      }
    }

    // 记录最终结果
    stepResult.status = 'completed';
    stepResult.output = lastOutput;
    stepResult.completedAt = new Date().toISOString();

    try {
      stepResult.structuredOutput = JSON.parse(lastOutput || '');
    } catch {
      // 非 JSON
    }

    this.emit('step:completed', { runId, stepId: step.id, output: lastOutput, iterations: stepResult.iteration });
  }

  /**
   * 模板变量解析
   * 支持：${inputs.xxx}, ${steps.xxx.output}, ${steps.xxx.status}
   */
  private resolveTemplate(template: string, run: WorkflowRun): string {
    return template.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
      const parts = path.split('.');

      if (parts[0] === 'inputs') {
        return String(run.inputs[parts[1]] ?? match);
      }

      if (parts[0] === 'steps' && parts.length >= 3) {
        const stepId = parts[1];
        const field = parts[2]; // "output" or "status"
        const stepResult = run.steps[stepId];
        if (!stepResult) return match;

        if (field === 'output') {
          if (parts.length > 3 && stepResult.structuredOutput) {
            // 支持 ${steps.review.output.approved} 深度访问
            let obj: unknown = stepResult.structuredOutput;
            for (let i = 3; i < parts.length; i++) {
              obj = (obj as Record<string, unknown>)?.[parts[i]];
            }
            return String(obj ?? match);
          }
          return stepResult.output ?? match;
        }

        if (field === 'status') return stepResult.status;
      }

      return match;
    });
  }

  /**
   * 条件表达式评估
   * 安全地评估简单条件，不使用 eval()
   */
  private evaluateCondition(condition: string, run: WorkflowRun): boolean {
    // 替换变量引用为实际值
    const resolved = this.resolveTemplate(condition, run);

    // 支持简单的比较操作
    // "true" / "false" 直接判断
    if (resolved.trim() === 'true') return true;
    if (resolved.trim() === 'false') return false;

    // "value === expected" 格式
    const eqMatch = resolved.match(/^(.+?)\s*===\s*(.+)$/);
    if (eqMatch) {
      const left = eqMatch[1].trim().replace(/^["']|["']$/g, '');
      const right = eqMatch[2].trim().replace(/^["']|["']$/g, '');
      return left === right;
    }

    // "value !== expected" 格式
    const neqMatch = resolved.match(/^(.+?)\s*!==\s*(.+)$/);
    if (neqMatch) {
      const left = neqMatch[1].trim().replace(/^["']|["']$/g, '');
      const right = neqMatch[2].trim().replace(/^["']|["']$/g, '');
      return left !== right;
    }

    // 默认：非空字符串视为 true
    return resolved.trim().length > 0 && resolved.trim() !== 'undefined' && resolved.trim() !== 'null';
  }

  /**
   * 循环条件评估
   */
  private evaluateLoopCondition(
    condition: string,
    context: { iteration: number; lastOutput: string | undefined; run: WorkflowRun },
  ): boolean {
    let resolved = condition;

    // 替换循环特有变量
    resolved = resolved.replace(/\biteration\b/g, String(context.iteration));
    resolved = resolved.replace(/\blastOutput\.(\w+)\b/g, (_, field: string) => {
      try {
        const obj = JSON.parse(context.lastOutput || '{}');
        return String(obj[field] ?? 'undefined');
      } catch {
        return 'undefined';
      }
    });

    return this.evaluateCondition(resolved, context.run);
  }

  /**
   * 解除依赖阻塞 — 当一个步骤完成后，检查并解除下游步骤的阻塞
   */
  private unblockDependentSteps(runId: string, definition: WorkflowDefinition, completedStepId: string): void {
    const run = this.runs.get(runId)!;

    for (const step of definition.steps) {
      if (!step.dependsOn?.includes(completedStepId)) continue;

      const stepResult = run.steps[step.id];
      if (stepResult.status !== 'blocked') continue;

      // 检查所有依赖是否都完成
      const allDepsCompleted = step.dependsOn.every(depId => {
        const dep = run.steps[depId];
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });

      if (allDepsCompleted) {
        stepResult.status = 'pending';
        this.emit('step:unblocked', { runId, stepId: step.id });
      }
    }
  }

  /**
   * 检查工作流是否已全部完成
   */
  private checkWorkflowCompletion(runId: string, definition: WorkflowDefinition): void {
    const run = this.runs.get(runId)!;

    const allDone = definition.steps.every(step => {
      const result = run.steps[step.id];
      return ['completed', 'skipped', 'failed'].includes(result.status);
    });

    if (allDone) {
      const hasFailure = definition.steps.some(step => run.steps[step.id].status === 'failed');
      run.status = hasFailure ? 'failed' : 'completed';
      run.completedAt = new Date().toISOString();

      this.emit('workflow:completed', {
        runId,
        status: run.status,
        steps: run.steps,
      });
    }
  }

  /**
   * 持久化工作流运行状态到数据库
   */
  private persistRun(run: WorkflowRun): void {
    // 存入 SQLite 或写入 JSON 文件
    // 具体实现取决于你的偏好
    run.updatedAt = new Date().toISOString();

    // 方案 A：存 SQLite
    // db.prepare(`INSERT OR REPLACE INTO workflow_runs ...`).run(...)

    // 方案 B：写 JSON 文件（更简单，便于调试）
    // fs.writeFileSync(`./data/workflows/${run.runId}.json`, JSON.stringify(run, null, 2))
  }

  /**
   * 获取工作流运行状态
   */
  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * 取消工作流
   */
  cancelWorkflow(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();

    // 标记所有运行中/待执行的步骤为取消
    for (const stepResult of Object.values(run.steps)) {
      if (['pending', 'blocked', 'running'].includes(stepResult.status)) {
        stepResult.status = 'skipped';
        stepResult.completedAt = new Date().toISOString();
        stepResult.error = 'Workflow cancelled';
      }
    }

    this.persistRun(run);
    this.emit('workflow:cancelled', { runId });
  }
}
```

### 3.4 预定义工作流示例

**新建 `workflows/code-review.workflow.json`**：

```json
{
  "id": "code-review-pipeline",
  "name": "代码审查流水线",
  "description": "编码 → 审查 → 修改（最多3轮） → 测试 → 完成",
  "inputs": {
    "task": {
      "type": "string",
      "required": true,
      "description": "需要实现的功能描述"
    },
    "project": {
      "type": "string",
      "required": true,
      "description": "项目名称"
    },
    "workingDirectory": {
      "type": "string",
      "required": true,
      "description": "代码工作目录"
    }
  },
  "steps": [
    {
      "id": "code",
      "name": "编码",
      "agentId": "programmer",
      "skillId": "coding",
      "task": "请在 ${inputs.workingDirectory} 目录中实现以下功能：\n\n${inputs.task}\n\n完成后，输出你修改的文件列表和变更摘要。"
    },
    {
      "id": "review",
      "name": "代码审查（可迭代）",
      "agentId": "reviewer",
      "skillId": "code-review",
      "dependsOn": ["code"],
      "task": "请审查以下代码变更：\n\n${steps.code.output}\n\n工作目录：${inputs.workingDirectory}\n\n请审查代码质量、安全性、可维护性。\n\n输出 JSON 格式：{\"approved\": true/false, \"feedback\": \"审查意见\", \"issues\": [\"问题1\", \"问题2\"]}",
      "loop": {
        "maxIterations": 3,
        "continueIf": "lastOutput.approved !== true"
      }
    },
    {
      "id": "test",
      "name": "运行测试",
      "agentId": "tester",
      "skillId": "testing",
      "dependsOn": ["review"],
      "condition": "${steps.review.output.approved} === true",
      "task": "请在 ${inputs.workingDirectory} 目录中运行测试套件，验证以下功能的实现：\n\n${inputs.task}\n\n如果没有测试文件，请先编写必要的测试，然后运行。\n\n输出 JSON 格式：{\"passed\": true/false, \"summary\": \"测试摘要\", \"coverage\": \"覆盖率\"}"
    },
    {
      "id": "notify",
      "name": "通知完成",
      "agentId": "main",
      "dependsOn": ["test"],
      "condition": "${steps.test.output.passed} === true",
      "task": "代码审查流水线已完成。请生成一份简洁的完成报告，包含：\n1. 实现的功能：${inputs.task}\n2. 审查结果：${steps.review.output}\n3. 测试结果：${steps.test.output}\n\n将报告格式化为用户友好的消息。"
    }
  ],
  "config": {
    "timeoutMs": 1800000,
    "failFast": false
  }
}
```

**新建 `workflows/parallel-research.workflow.json`**（并行执行示例）：

```json
{
  "id": "parallel-research",
  "name": "并行调研",
  "description": "多个 Agent 并行调研不同方向，最后由主 Agent 综合",
  "inputs": {
    "topic": {
      "type": "string",
      "required": true,
      "description": "调研主题"
    }
  },
  "steps": [
    {
      "id": "research-tech",
      "name": "技术调研",
      "agentId": "researcher",
      "skillId": "tech-research",
      "task": "请从技术实现角度调研：${inputs.topic}。重点关注技术栈、架构方案、性能指标。"
    },
    {
      "id": "research-market",
      "name": "市场调研",
      "agentId": "researcher",
      "skillId": "market-research",
      "task": "请从市场和竞品角度调研：${inputs.topic}。重点关注市场规模、主要竞品、差异化机会。"
    },
    {
      "id": "research-risk",
      "name": "风险评估",
      "agentId": "researcher",
      "skillId": "risk-assessment",
      "task": "请评估以下项目的风险：${inputs.topic}。重点关注技术风险、合规风险、资源风险。"
    },
    {
      "id": "synthesis",
      "name": "综合报告",
      "agentId": "main",
      "dependsOn": ["research-tech", "research-market", "research-risk"],
      "task": "请综合以下三方面的调研结果，生成一份完整的调研报告：\n\n## 技术调研\n${steps.research-tech.output}\n\n## 市场调研\n${steps.research-market.output}\n\n## 风险评估\n${steps.research-risk.output}\n\n请给出最终建议。"
    }
  ],
  "config": {
    "timeoutMs": 600000
  }
}
```

### 3.5 工作流触发集成

**修改飞书消息处理层，支持工作流触发**：

```typescript
// src/gateway/workflow-trigger.ts

import { WorkflowEngine } from '../workflow/engine.js';

const workflowEngine = new WorkflowEngine();

// 启动时加载工作流定义
await workflowEngine.loadWorkflowsFromDir('./workflows');

/**
 * 检测用户消息是否要触发工作流
 *
 * 触发方式：
 *   /workflow code-review-pipeline --task "实现用户登录功能" --project "my-app" --workingDirectory "/path/to/project"
 *   /pipeline code-review "实现用户登录功能"
 */
export function detectWorkflowTrigger(message: string): {
  workflowId: string;
  inputs: Record<string, unknown>;
} | null {
  // 方式1：显式指令
  const cmdMatch = message.match(/^\/(?:workflow|pipeline)\s+(\S+)\s*(.*)/s);
  if (cmdMatch) {
    const workflowId = cmdMatch[1];
    const argsStr = cmdMatch[2].trim();

    // 解析 --key value 参数
    const inputs: Record<string, unknown> = {};
    const argRegex = /--(\w+)\s+"([^"]+)"|--(\w+)\s+(\S+)/g;
    let argMatch;
    while ((argMatch = argRegex.exec(argsStr)) !== null) {
      const key = argMatch[1] || argMatch[3];
      const value = argMatch[2] || argMatch[4];
      inputs[key] = value;
    }

    return { workflowId, inputs };
  }

  // 方式2：自然语言匹配（可扩展）
  // 例如检测 "帮我做一个代码审查流水线" 之类的表述

  return null;
}

/**
 * 在消息处理管道中集成
 */
export async function handleMessage(userId: string, message: string): Promise<void> {
  const trigger = detectWorkflowTrigger(message);

  if (trigger) {
    const runId = await workflowEngine.startWorkflow(
      trigger.workflowId,
      trigger.inputs,
      userId,
    );

    // 通知用户工作流已启动
    await sendFeishuMessage(userId, `🚀 工作流 **${trigger.workflowId}** 已启动\n运行 ID: \`${runId}\`\n\n我会在各步骤完成时通知你进展。`);

    // 监听事件，推送进度到飞书
    workflowEngine.on('step:completed', (event) => {
      if (event.runId === runId) {
        sendFeishuMessage(userId, `✅ 步骤 **${event.stepId}** 完成`);
      }
    });

    workflowEngine.on('workflow:completed', (event) => {
      if (event.runId === runId) {
        sendFeishuMessage(userId, `🎉 工作流 **${trigger.workflowId}** 全部完成！`);
      }
    });

    workflowEngine.on('workflow:failed', (event) => {
      if (event.runId === runId) {
        sendFeishuMessage(userId, `❌ 工作流失败: ${event.error}`);
      }
    });
  } else {
    // 常规单 Agent 处理（现有逻辑）
    await handleSingleAgentMessage(userId, message);
  }
}
```

### 3.6 工作流状态持久化

**在 `src/db/index.ts` 中新增 `workflow_runs` 表**：

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  inputs TEXT NOT NULL,             -- JSON
  steps TEXT NOT NULL,              -- JSON，所有步骤的状态
  triggered_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  error TEXT
);

CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
```

---

## 四、Phase 3：独立 Agent Profile

### 4.1 目标

让每个 Agent 有独立的身份、模型选择、工具权限和工作目录，实现真正的角色隔离。

### 4.2 Agent Profile 定义

**新建 `src/agent/profile.ts`**：

```typescript
// src/agent/profile.ts

export interface AgentProfile {
  /** Agent 唯一 ID */
  id: string;

  /** Agent 名称 */
  name: string;

  /** Agent 描述 */
  description: string;

  /** 使用的 Skill ID */
  skillId: string;

  /** 模型配置 */
  model?: {
    /** 模型标识，如 "claude-sonnet-4-20250514" */
    modelId?: string;
    /** 最大 tokens */
    maxTokens?: number;
    /** 温度 */
    temperature?: number;
  };

  /** 工作目录（独立隔离） */
  workspace?: string;

  /** 工具白名单 — 限制该 Agent 可以使用的工具 */
  allowedTools?: string[];

  /** 工具黑名单 */
  deniedTools?: string[];

  /** 并发限制 — 该 Agent 最多同时运行几个任务 */
  maxConcurrent?: number;

  /** 可以通信的 Agent 列表（空数组 = 不能通信，undefined = 可以和所有 Agent 通信） */
  allowedPeers?: string[];

  /** 附加的 system prompt 片段 */
  systemPromptAppend?: string;
}

/**
 * Agent 注册表 — 管理所有 Agent Profile
 */
export class AgentRegistry {
  private profiles: Map<string, AgentProfile> = new Map();

  /**
   * 从配置文件加载 Agent Profiles
   */
  async loadFromDir(dir: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');

    const files = await fs.readdir(dir);
    for (const file of files) {
      if (file.endsWith('.agent.json')) {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const profile = JSON.parse(content) as AgentProfile;
        this.register(profile);
      }
    }
  }

  register(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile);
  }

  get(agentId: string): AgentProfile | undefined {
    return this.profiles.get(agentId);
  }

  getOrDefault(agentId: string): AgentProfile {
    return this.profiles.get(agentId) || {
      id: agentId,
      name: agentId,
      description: `Default profile for ${agentId}`,
      skillId: 'default',
    };
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * 检查两个 Agent 是否可以互相通信
   */
  canCommunicate(fromAgentId: string, toAgentId: string): boolean {
    const from = this.get(fromAgentId);
    if (!from) return false;

    // allowedPeers 未定义 = 允许所有
    if (from.allowedPeers === undefined) return true;

    return from.allowedPeers.includes(toAgentId);
  }
}
```

### 4.3 预定义 Agent Profile 示例

**`agents/programmer.agent.json`**：

```json
{
  "id": "programmer",
  "name": "编码专家",
  "description": "负责代码实现、重构和优化",
  "skillId": "coding",
  "model": {
    "modelId": "claude-sonnet-4-20250514"
  },
  "workspace": "./workspaces/programmer",
  "allowedTools": ["bash", "read", "write", "edit", "search"],
  "maxConcurrent": 2,
  "allowedPeers": ["reviewer", "tester", "main"],
  "systemPromptAppend": "你是一个资深全栈工程师。请按照最佳实践编写代码，注重可读性和可维护性。"
}
```

**`agents/reviewer.agent.json`**：

```json
{
  "id": "reviewer",
  "name": "代码审查专家",
  "description": "负责代码质量审查、安全检查",
  "skillId": "code-review",
  "model": {
    "modelId": "claude-sonnet-4-20250514"
  },
  "workspace": "./workspaces/reviewer",
  "allowedTools": ["bash", "read", "search"],
  "maxConcurrent": 3,
  "allowedPeers": ["programmer", "main"],
  "systemPromptAppend": "你是一个严格的代码审查者。关注代码质量、安全漏洞、性能问题。输出结构化的审查结果 JSON。"
}
```

**`agents/tester.agent.json`**：

```json
{
  "id": "tester",
  "name": "测试专家",
  "description": "负责编写和运行测试",
  "skillId": "testing",
  "model": {
    "modelId": "claude-sonnet-4-20250514"
  },
  "workspace": "./workspaces/tester",
  "allowedTools": ["bash", "read", "write", "search"],
  "maxConcurrent": 2,
  "allowedPeers": ["programmer", "main"],
  "systemPromptAppend": "你是一个测试工程师。编写全面的测试用例，确保代码质量。"
}
```

### 4.4 Executor 集成 Agent Profile

**修改 `src/worker/executor.ts`，根据 Agent Profile 调整 Claude Code CLI 调用参数**：

```typescript
// src/worker/executor.ts — 集成 Agent Profile

import { AgentRegistry } from '../agent/profile.js';

const agentRegistry = new AgentRegistry();
await agentRegistry.loadFromDir('./agents');

export async function executeTask(task: PendingTask): Promise<TaskResult> {
  const agentId = task.agentId || 'main';
  const profile = agentRegistry.getOrDefault(agentId);

  // 检查并发限制
  if (profile.maxConcurrent) {
    const currentCount = getRunningTaskCount(agentId);
    if (currentCount >= profile.maxConcurrent) {
      // 放回队列等待
      return { status: 'requeued', reason: `Agent ${agentId} at max concurrency` };
    }
  }

  const sessionKey = task.sessionKey || makeSessionKey(agentId, task.userId);

  // 读取收件箱
  const inboxMessages = readAgentMessages(sessionKey);

  // 检查通信权限
  const filteredInbox = inboxMessages.filter(m => {
    const parsed = parseSessionKey(m.fromSession);
    return parsed && agentRegistry.canCommunicate(parsed.agentId, agentId);
  });

  // 构造 Claude Code CLI 参数
  const cliArgs: ClaudeCodeOptions = {
    systemPrompt: buildSystemPrompt(profile, filteredInbox),
    userMessage: task.userMessage,
    workingDirectory: profile.workspace || task.workingDirectory,
    // 根据 profile 设置模型
    ...(profile.model?.modelId && { model: profile.model.modelId }),
    ...(profile.model?.maxTokens && { maxTokens: profile.model.maxTokens }),
    // 工具限制（通过 --allowedTools CLI 参数传递，取决于 Claude Code CLI 的支持情况）
    // 如果 Claude Code CLI 不支持工具白名单，则在 system prompt 中约束
  };

  const result = await claudeCodeCLI.execute(cliArgs);

  // 解析通信指令
  const commands = parseAgentCommands(result.output);

  for (const cmd of commands) {
    if (cmd.type === 'AGENT_SEND') {
      // 检查发送权限
      const targetParsed = parseSessionKey(cmd.to!);
      if (targetParsed && agentRegistry.canCommunicate(agentId, targetParsed.agentId)) {
        sendAgentMessage({
          fromSession: sessionKey,
          toSession: cmd.to!,
          message: cmd.content,
          messageType: cmd.messageType as any || 'text',
        });
      }
    }

    // 如果是工作流任务，将结果发送回工作流引擎
    if (cmd.type === 'TASK_DONE' && task.correlationId) {
      sendAgentMessage({
        fromSession: sessionKey,
        toSession: `workflow:${task.metadata?.runId}`,
        message: cmd.content,
        messageType: 'task_result',
        correlationId: task.correlationId,
      });
    }
  }

  return { output: result.output, commands };
}

function buildSystemPrompt(profile: AgentProfile, inbox: AgentMessage[]): string {
  const sections: string[] = [];

  // 1. Skill prompt
  const skill = loadSkill(profile.skillId);
  if (skill?.systemPrompt) sections.push(skill.systemPrompt);

  // 2. Agent 身份
  sections.push(`## 你的身份\n\n你是 **${profile.name}**。${profile.description}`);

  // 3. Agent 附加指令
  if (profile.systemPromptAppend) sections.push(profile.systemPromptAppend);

  // 4. 工具限制说明
  if (profile.allowedTools) {
    sections.push(`## 工具限制\n\n你只能使用以下工具：${profile.allowedTools.join(', ')}。不要尝试使用其他工具。`);
  }
  if (profile.deniedTools) {
    sections.push(`## 禁止使用的工具\n\n以下工具禁止使用：${profile.deniedTools.join(', ')}。`);
  }

  // 5. Agent 通信工具
  sections.push(AGENT_TOOLS_PROMPT);

  // 6. 收件箱
  if (inbox.length > 0) {
    sections.push(formatInboxForPrompt(inbox));
  }

  return sections.join('\n\n---\n\n');
}
```

---

## 五、新增文件清单

以下是本次改造需要新建/修改的所有文件：

### 5.1 新建文件

| 文件路径 | 用途 | Phase |
|:------|:------|:--------|
| `src/agent/session.ts` | Session Key 命名与解析 | Phase 1 |
| `src/agent/command-parser.ts` | Agent 通信指令解析器 | Phase 1 |
| `src/agent/profile.ts` | Agent Profile 定义与注册表 | Phase 3 |
| `src/workflow/types.ts` | 工作流类型定义 | Phase 2 |
| `src/workflow/engine.ts` | 工作流编排引擎 | Phase 2 |
| `src/gateway/workflow-trigger.ts` | 工作流触发与飞书集成 | Phase 2 |
| `workflows/code-review.workflow.json` | 代码审查流水线定义 | Phase 2 |
| `workflows/parallel-research.workflow.json` | 并行调研流水线定义 | Phase 2 |
| `agents/programmer.agent.json` | 编码 Agent Profile | Phase 3 |
| `agents/reviewer.agent.json` | 审查 Agent Profile | Phase 3 |
| `agents/tester.agent.json` | 测试 Agent Profile | Phase 3 |
| `tests/agent-messaging.test.ts` | Agent 通信测试 | Phase 1 |
| `tests/workflow-engine.test.ts` | 工作流引擎测试 | Phase 2 |

### 5.2 修改文件

| 文件路径 | 修改内容 | Phase |
|:------|:------|:--------|
| `src/db/index.ts` | 新增 agent_messages 表 + CRUD 操作 | Phase 1 |
| `src/worker/executor.ts` | 注入收件箱、解析通信指令、集成 Agent Profile | Phase 1 + 3 |
| `src/queue/index.ts` | enqueueTask 增加 agentId、correlationId、metadata 字段 | Phase 1 |
| `src/config/schema.ts` | 新增 workflow 和 agent 相关配置项 | Phase 2 + 3 |
| `src/worker/engine.ts` | Worker 调度时考虑 Agent 并发限制 | Phase 3 |

---

## 六、数据流总览

### 6.1 单 Agent 模式（现有，不变）

```
飞书用户消息
  → Gateway
  → enqueueTask(sessionKey="agent:main:user-123", message="帮我写个函数")
  → Worker Engine 分配 Worker
  → Executor 调用 Claude Code CLI
  → 飞书回复
```

### 6.2 多 Agent 模式（Phase 1）

```
飞书用户消息: "帮我写一个登录功能，然后请 reviewer 审查"
  → Gateway
  → enqueueTask(sessionKey="agent:main:user-123", agentId="main", message=...)
  → Worker → Executor → Claude Code CLI

  Claude 输出:
    "代码已写好。
     [AGENT_SEND to="agent:reviewer:user-123" type="task_request"]
     请审查我刚写的登录功能代码...
     [/AGENT_SEND]
     [TASK_DONE status="success"]编码完成[/TASK_DONE]"

  → 命令解析器 parseAgentCommands()
  → sendAgentMessage("agent:main:user-123" → "agent:reviewer:user-123")
  → （需要额外机制触发 reviewer 的执行，见下方）
```

**消息触发执行**：当有新消息写入 `agent_messages` 时，需要检查目标 Agent 是否有待处理的任务。如果没有，自动创建一个：

```typescript
// 在 sendAgentMessage 之后
async function triggerAgentIfNeeded(toSession: string, message: AgentMessage): void {
  // 检查目标 Agent 是否已有运行中的任务
  const existingTask = db.prepare(
    `SELECT id FROM pending_tasks WHERE sessionKey = ? AND status IN ('pending', 'processing') LIMIT 1`
  ).get(toSession);

  if (!existingTask) {
    // 自动创建任务，让目标 Agent 处理收件箱消息
    const parsed = parseSessionKey(toSession);
    if (parsed) {
      enqueueTask({
        sessionKey: toSession,
        agentId: parsed.agentId,
        userMessage: `你有新的收件箱消息，请查看并处理。`,
        metadata: { triggeredByMessage: message.id },
      });
    }
  }
}
```

### 6.3 工作流编排模式（Phase 2）

```
飞书用户消息: "/workflow code-review-pipeline --task '实现用户登录' --project 'my-app'"
  → detectWorkflowTrigger()
  → WorkflowEngine.startWorkflow("code-review-pipeline", inputs)
  → 初始化所有步骤状态

  Step "code" (无依赖，立即执行):
    → enqueueTask(agentId="programmer", task="实现用户登录...")
    → Worker → Executor → Claude Code CLI
    → 解析 [TASK_DONE] → sendAgentMessage → workflow engine
    → 步骤完成

  Step "review" (依赖 "code"，解除阻塞):
    → enqueueTask(agentId="reviewer", task="审查代码...")
    → Worker → Executor → Claude Code CLI
    → 返回 {approved: false, feedback: "..."}
    → 循环条件检查: approved !== true → 继续 iteration 2
    → ... 最多 3 轮 ...

  Step "test" (依赖 "review"，条件检查 approved === true):
    → enqueueTask(agentId="tester", task="运行测试...")
    → Worker → Executor → Claude Code CLI
    → 返回 {passed: true}

  Step "notify":
    → enqueueTask(agentId="main", task="生成完成报告...")
    → 飞书消息推送给用户

  ✅ 工作流完成
```

---

## 七、配置项新增

**在 `src/config/schema.ts` 中扩展**：

```typescript
// 在现有 schema 基础上新增

const multiAgentSchema = z.object({
  /** Agent 通信相关配置 */
  agentMessaging: z.object({
    /** 是否启用 Agent 间通信 */
    enabled: z.boolean().default(true),
    /** 消息默认过期时间（毫秒），0 = 永不过期 */
    defaultExpiresMs: z.number().default(3600_000), // 1 小时
    /** 单个 Agent 收件箱最大消息数 */
    maxInboxSize: z.number().default(50),
    /** 同步等待回复的默认超时（毫秒） */
    defaultReplyTimeoutMs: z.number().default(120_000), // 2 分钟
  }).default({}),

  /** 工作流相关配置 */
  workflow: z.object({
    /** 是否启用工作流引擎 */
    enabled: z.boolean().default(true),
    /** 工作流定义文件目录 */
    definitionsDir: z.string().default('./workflows'),
    /** 单个工作流最大步骤数 */
    maxStepsPerWorkflow: z.number().default(20),
    /** 单个步骤最大超时（毫秒） */
    maxStepTimeoutMs: z.number().default(600_000), // 10 分钟
    /** 并发运行的最大工作流数 */
    maxConcurrentWorkflows: z.number().default(5),
  }).default({}),

  /** Agent Profile 相关配置 */
  agents: z.object({
    /** Agent Profile 文件目录 */
    profilesDir: z.string().default('./agents'),
    /** 默认 Agent 的并发限制 */
    defaultMaxConcurrent: z.number().default(3),
    /** 是否启用 Agent 间通信权限检查 */
    enforceCommPermissions: z.boolean().default(true),
  }).default({}),
});
```

---

## 八、实施顺序与验收标准

### 8.1 Phase 1 实施清单（预计 2-3 天）

| # | 任务 | 验收标准 |
|:--|:------|:------|
| 1 | 创建 `agent_messages` 表 | 表结构正确，索引生效 |
| 2 | 实现 `sendAgentMessage()` | 消息写入 DB，返回消息 ID |
| 3 | 实现 `readAgentMessages()` | 读取未读消息，自动标记已读，过期消息自动清理 |
| 4 | 实现 `waitForReply()` | 阻塞等待指定 correlationId 的回复，超时返回 null |
| 5 | 实现 `command-parser.ts` | 正确解析 `[AGENT_SEND]` 和 `[TASK_DONE]` 指令 |
| 6 | 实现 `session.ts` | Session Key 创建和解析工具函数 |
| 7 | 改造 `executor.ts` — 收件箱注入 | Claude Code CLI 能看到收件箱消息 |
| 8 | 改造 `executor.ts` — 输出解析 | 解析 CLI 输出中的通信指令，写入 DB |
| 9 | 实现消息触发执行 | 新消息到达时自动触发目标 Agent |
| 10 | 编写单元测试 | 所有 Agent 通信场景测试通过 |

### 8.2 Phase 2 实施清单（预计 3-5 天）

| # | 任务 | 验收标准 |
|:--|:------|:------|
| 1 | 实现 `workflow/types.ts` | 类型定义完整，支持 IDE 自动补全 |
| 2 | 实现 `workflow/engine.ts` — 基础调度 | 线性步骤按顺序执行 |
| 3 | 实现依赖管理 | `dependsOn` 阻塞/解除正确 |
| 4 | 实现条件执行 | `condition` 评估正确，不满足时 skip |
| 5 | 实现循环 | `loop` 迭代正确，达到退出条件或最大次数时停止 |
| 6 | 实现模板变量 | `${inputs.xxx}` 和 `${steps.xxx.output}` 正确解析 |
| 7 | 实现状态持久化 | 工作流状态写入 DB，重启后可恢复 |
| 8 | 实现飞书触发 | `/workflow` 指令正确触发工作流 |
| 9 | 实现进度通知 | 步骤完成/失败时推送飞书消息 |
| 10 | 创建示例工作流 | code-review 和 parallel-research 两个示例可运行 |

### 8.3 Phase 3 实施清单（预计 1-2 天）

| # | 任务 | 验收标准 |
|:--|:------|:------|
| 1 | 实现 `agent/profile.ts` | Profile 加载、注册、查询正确 |
| 2 | 创建示例 Agent Profile JSON | programmer / reviewer / tester 三个 Profile |
| 3 | Executor 集成 Profile | 根据 Profile 使用不同 workspace / model / 工具限制 |
| 4 | 通信权限检查 | `allowedPeers` 限制正确生效 |
| 5 | 并发限制 | 单 Agent 并发不超过 `maxConcurrent` |

---

## 九、注意事项与边界条件

### 9.1 防止无限循环

当 Agent A 发消息给 Agent B，B 又发回给 A 时，可能导致无限循环。需要加入熔断机制：

```typescript
// 在 triggerAgentIfNeeded 中加入循环检测
const MAX_PING_PONG_TURNS = 5;

function detectPingPong(fromSession: string, toSession: string): boolean {
  const recentMessages = db.prepare(`
    SELECT from_session, to_session FROM agent_messages
    WHERE (from_session = ? AND to_session = ?) OR (from_session = ? AND to_session = ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(fromSession, toSession, toSession, fromSession, MAX_PING_PONG_TURNS * 2);

  // 检查是否来回互发超过阈值
  let pingPongCount = 0;
  let lastFrom = '';
  for (const msg of recentMessages) {
    if (msg.from_session !== lastFrom) {
      pingPongCount++;
      lastFrom = msg.from_session;
    }
  }

  return pingPongCount >= MAX_PING_PONG_TURNS;
}
```

### 9.2 资源隔离

确保每个 Agent 的 Claude Code CLI 进程使用独立的工作目录：

```typescript
// 在 executor 中
const workDir = profile.workspace
  ? path.resolve(profile.workspace)
  : path.resolve(`./workspaces/${profile.id}`);

// 确保目录存在
await fs.mkdir(workDir, { recursive: true });
```

### 9.3 错误传播

工作流中某个步骤失败时，需要正确传播错误并清理资源：

- `failFast: true` — 任一步骤失败立即终止整个工作流
- `failFast: false` — 继续执行不依赖失败步骤的其他步骤
- 所有情况下都要通知用户失败原因

### 9.4 Claude Code CLI 调用方式

根据你的 executor.ts 现有实现，Claude Code CLI 通常通过以下方式调用：

```bash
# 方式 1: --print 模式（无状态，推荐用于多 Agent）
claude --print "你的任务描述" --system-prompt "system prompt 内容"

# 方式 2: 会话模式（有状态，适合长对话）
claude --session-id "agent:programmer:project-abc" "你的任务描述"
```

多 Agent 场景推荐使用 `--print` 模式，因为：
1. 每次调用独立，不会出现上下文污染
2. system prompt 可以动态注入收件箱消息
3. 方便控制并发

---

## 十、扩展方向（未来可选）

| 方向 | 说明 | 参考 |
|:------|:------|:------|
| **Agent Teams** | 共享任务列表、依赖管理、角色分工 | OpenClaw RFC: Agent Teams |
| **STATE.yaml 协调** | 文件共享状态，去中心化协调 | OpenClaw Autonomous Project Management 模式 |
| **Webhook 触发** | 外部系统（CI/CD、GitHub）触发工作流 | OpenClaw /hooks/agent |
| **可视化 Dashboard** | 在飞书卡片中展示工作流进度和 Agent 状态 | 飞书互动卡片 |
| **成本控制** | 不同 Agent 使用不同模型，审查用便宜模型 | OpenClaw per-spawn model override |
| **记忆系统** | Agent 间共享长期记忆 | OpenClaw Memory Search |