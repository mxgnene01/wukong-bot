# 功能增强实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 4 个核心功能增强：Claude CLI 增强参数、流式输出、安全约束、定时任务自然语言解析。

**Architecture:** 采用增量式实现，每个功能独立模块，通过 worker/executor 集成。先增强 Agent，再添加流式输出，然后安全约束，最后定时任务解析。

**Tech Stack:** Bun + TypeScript + Hono + @larksuiteoapi/node-sdk

---

## Task 1: 增强 Claude Agent - 添加新参数支持

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/types/index.ts`

**Step 1: Update types in src/types/index.ts**

Add to the AgentOptions and related types:

```typescript
// 在 src/types/index.ts 中添加或更新 AgentOptions
export interface AgentOptions {
  systemPrompt?: string;
  timeout?: number;
  workDir?: string;
  resumeSessionId?: string;
  streamOutput?: boolean;
  skipPermissions?: boolean;
  onStreamChunk?: (chunk: any) => void;
}

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  sessionId?: string;
}
```

**Step 2: Modify src/agent/index.ts - Update ClaudeAgent class**

Update the AgentOptions interface and add safety prompt:

```typescript
// 在文件顶部添加安全约束提示
const SAFETY_PROMPT = `
你正在通过飞书与用户交互，用户无法直接在终端确认操作。

对于以下危险操作，必须先向用户说明并等待明确确认后再执行：
- rm / rm -rf（删除文件）
- git push --force / git reset --hard
- DROP TABLE / DELETE FROM
`;

interface AgentOptions {
  systemPrompt?: string;
  timeout?: number;
  workDir?: string;
  resumeSessionId?: string;
  streamOutput?: boolean;
  skipPermissions?: boolean;
  onStreamChunk?: (chunk: any) => void;
}
```

**Step 3: Modify src/agent/index.ts - Update buildArgs method**

Update the buildArgs method to support new parameters:

```typescript
private buildArgs(options: AgentOptions): string[] {
  const args: string[] = [];

  if (options.systemPrompt) {
    args.push('--append-system-prompt', SAFETY_PROMPT + '\n\n' + options.systemPrompt);
  } else {
    args.push('--append-system-prompt', SAFETY_PROMPT);
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  if (options.streamOutput) {
    args.push('--output-format', 'stream-json');
  }

  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  return args;
}
```

**Step 4: Verify changes**

Check that `src/agent/index.ts` has the new options and safety prompt.

---

## Task 2: 创建流式输出处理器

**Files:**
- Create: `src/agent/stream.ts`

**Step 1: Create src/agent/stream.ts**

```typescript
import { buildProgressCard } from '../cards';
import { updateCard } from '../lark/client';
import { getDB } from '../db';

export interface StreamChunk {
  type: string;
  content?: string;
  tool?: {
    name: string;
    input: any;
  };
  [key: string]: any;
}

export class StreamProcessor {
  private taskId: string;
  private cardMessageId: string | null = null;
  private buffer = '';
  private lastUpdateTime = 0;
  private updateIntervalMs = 2000;
  private minCharsBeforeUpdate = 500;
  private db = getDB();
  private isComplete = false;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.cardMessageId = this.db.getSetting(`card:${taskId}`);
  }

  async processChunk(chunk: StreamChunk) {
    if (this.isComplete) return;

    if (chunk.type === 'content' && chunk.content) {
      this.buffer += chunk.content;
      await this.tryUpdate();
    } else if (chunk.type === 'tool_use') {
      this.buffer += `\n[使用工具: ${chunk.tool?.name}]\n`;
      await this.tryUpdate();
    }
  }

  private async tryUpdate() {
    const now = Date.now();
    const shouldUpdate =
      now - this.lastUpdateTime > this.updateIntervalMs ||
      this.buffer.length - this.lastBufferLength > this.minCharsBeforeUpdate;

    if (shouldUpdate) {
      await this.updateCard();
      this.lastUpdateTime = now;
      this.lastBufferLength = this.buffer.length;
    }
  }

  private lastBufferLength = 0;

  private async updateCard() {
    if (!this.cardMessageId) return;

    try {
      const displayContent = this.buffer.length > 2000
        ? this.buffer.slice(-2000) + '\n...'
        : this.buffer;

      await updateCard(
        this.cardMessageId,
        buildProgressCard('processing', displayContent, undefined, this.taskId)
      );
    } catch (e) {
      console.error('[Stream] Failed to update card:', e);
    }
  }

  async complete(finalOutput: string) {
    this.isComplete = true;
    this.buffer = finalOutput;
    await this.updateCard();
  }
}

export function createStreamProcessor(taskId: string) {
  return new StreamProcessor(taskId);
}
```

**Step 2: Verify file created**

Check that `src/agent/stream.ts` exists with the above content.

---

## Task 3: 集成流式输出到 Worker Executor

**Files:**
- Modify: `src/worker/executor.ts`

**Step 1: Update src/worker/executor.ts - Add imports**

Add at the top of the file:

```typescript
import { createStreamProcessor, type StreamChunk } from '../agent/stream';
```

**Step 2: Update src/worker/executor.ts - Modify execute method**

Update the execute method to support streaming:

```typescript
// 在 execute 方法中，调用 agent.execute 之前添加
const streamProcessor = createStreamProcessor(task.id);

const result = await this.agent.execute(task.content, {
  systemPrompt: fullSystemPrompt,
  timeout: this.config.claude.timeout,
  streamOutput: true,
  skipPermissions: true,
  onStreamChunk: (chunk: StreamChunk) => {
    streamProcessor.processChunk(chunk);
  },
});

await streamProcessor.complete(result.output);
```

**Step 3: Verify changes**

Check that `src/worker/executor.ts` has the streaming integration.

---

## Task 4: 创建安全确认模块

**Files:**
- Create: `src/confirmation/index.ts`

**Step 1: Create src/confirmation/index.ts**

```typescript
import type { ChatContext } from '../types';
import { sendCard, updateCard } from '../lark/client';
import { buildProgressCard } from '../cards';

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\brm\s+-r\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
];

export interface Confirmation {
  id: string;
  taskId: string;
  context: ChatContext;
  message: string;
  cardMessageId: string;
  confirmed: boolean;
  createdAt: number;
}

export class ConfirmationManager {
  private pendingConfirmations = new Map<string, Confirmation>();
  private resolveMap = new Map<string, (confirmed: boolean) => void>();

  checkDangerousOperation(output: string): boolean {
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(output));
  }

  async requestConfirmation(
    taskId: string,
    context: ChatContext,
    message: string
  ): Promise<boolean> {
    const confirmationId = crypto.randomUUID();

    const cardMessageId = await sendCard(
      context,
      buildProgressCard('processing', `⚠️ 危险操作确认\n\n${message}\n\n请确认是否继续？`, undefined, taskId)
    );

    return new Promise((resolve) => {
      this.pendingConfirmations.set(confirmationId, {
        id: confirmationId,
        taskId,
        context,
        message,
        cardMessageId,
        confirmed: false,
        createdAt: Date.now(),
      });
      this.resolveMap.set(confirmationId, resolve);
    });
  }

  async confirm(confirmationId: string, confirmed: boolean) {
    const confirmation = this.pendingConfirmations.get(confirmationId);
    if (!confirmation) return;

    confirmation.confirmed = confirmed;
    const resolve = this.resolveMap.get(confirmationId);

    if (resolve) {
      resolve(confirmed);
      this.pendingConfirmations.delete(confirmationId);
      this.resolveMap.delete(confirmationId);
    }
  }

  getPendingConfirmation(taskId: string): Confirmation | undefined {
    for (const conf of this.pendingConfirmations.values()) {
      if (conf.taskId === taskId) {
        return conf;
      }
    }
    return undefined;
  }
}

let managerInstance: ConfirmationManager | null = null;

export function getConfirmationManager(): ConfirmationManager {
  if (!managerInstance) {
    managerInstance = new ConfirmationManager();
  }
  return managerInstance;
}
```

**Step 2: Verify file created**

Check that `src/confirmation/index.ts` exists with the above content.

---

## Task 5: 创建定时任务自然语言解析器

**Files:**
- Create: `src/cron/parser.ts`

**Step 1: Create src/cron/parser.ts**

```typescript
import { getAgent } from '../agent';

export interface ParsedSchedule {
  cron: string;
  description: string;
  content: string;
}

export async function parseNaturalLanguageSchedule(input: string): Promise<ParsedSchedule | null> {
  const match = input.match(/^定时\s*(.+?)\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const [, timeDesc, content] = match;

  const agent = getAgent();
  const prompt = `
将以下自然语言时间描述转换成 cron 表达式。

时间描述：${timeDesc}

请只输出 cron 表达式，不要其他内容。

常见例子：
- "每天早上10点" → "0 10 * * *"
- "每个工作日9点" → "0 9 * * 1-5"
- "每周一早上8点半" → "30 8 * * 1"
- "每小时" → "0 * * * *"
`;

  const result = await agent.execute(prompt, { skipPermissions: true });

  if (!result.success) {
    return null;
  }

  const cron = result.output.trim();

  return {
    cron,
    description: timeDesc,
    content: content.trim(),
  };
}

export function isScheduleCommand(input: string): boolean {
  return /^定时\s*/i.test(input);
}
```

**Step 2: Verify file created**

Check that `src/cron/parser.ts` exists with the above content.

---

## Task 6: 集成定时任务解析到主流程

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cron/index.ts`

**Step 1: Update src/cron/index.ts - Add parser integration**

Add import at the top:

```typescript
import { parseNaturalLanguageSchedule, isScheduleCommand } from './parser';
import { getDB } from '../db';
```

Add a new function:

```typescript
export async function handleScheduleCommand(input: string, context: any): Promise<boolean> {
  if (!isScheduleCommand(input)) {
    return false;
  }

  const parsed = await parseNaturalLanguageSchedule(input);
  if (!parsed) {
    return false;
  }

  const db = getDB();
  db.createScheduledTask(
    `定时任务: ${parsed.description}`,
    parsed.cron,
    context,
    parsed.content
  );

  return true;
}
```

**Step 2: Update src/index.ts - Add schedule command detection**

In the handleEvent function, before processing normally:

```typescript
import { handleScheduleCommand } from './cron';

// 在 handleEvent 函数中，中间件执行之后添加
if (ctx.content && await handleScheduleCommand(ctx.content, ctx.context)) {
  return;
}
```

**Step 3: Verify changes**

Check that both files are updated correctly.

---

## Summary

This plan implements all 4 enhancements:
1. Claude Agent with new parameters (resume, stream-json, skip-permissions, safety prompt)
2. Streaming output with batched card updates
3. Safety confirmation with card buttons
4. Natural language schedule parsing

All modules are independent and integrate through the worker executor.
