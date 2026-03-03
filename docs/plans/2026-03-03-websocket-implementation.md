# 飞书 WebSocket 长连接模式实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 添加飞书 WebSocket 长连接模式支持，无需内网穿透即可本地开发。

**Architecture:** 创建统一的 EventSource 接口，WebSocket 和 Webhook 两种实现，通过配置切换。

**Tech Stack:** Bun + TypeScript + @larksuiteoapi/node-sdk

---

## Task 1: 创建事件源抽象接口

**Files:**
- Create: `src/lark/eventsource.ts`

**Step 1: Create the EventSource interface**

```typescript
import type { LarkMessageEvent } from '../types';

export interface EventSource {
  type: 'websocket' | 'webhook';
  onEvent(handler: (event: LarkMessageEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type EventHandler = (event: LarkMessageEvent) => void;
```

**Step 2: Verify file created**

Check that `src/lark/eventsource.ts` exists with the above content.

---

## Task 2: 更新配置 Schema 支持事件源选择

**Files:**
- Modify: `src/config/schema.ts`

**Step 1: Add eventSource to AppConfig**

Find the `AppConfig` interface and add:

```typescript
export interface AppConfig {
  name: string;
  version: string;
  env: 'development' | 'production' | 'test';
  port: number;
  workDir: string;
  eventSource: 'websocket' | 'webhook';  // <-- 新增
}
```

**Step 2: Update defaultConfig**

In the `defaultConfig` object, add to the `app` section:

```typescript
app: {
  name: 'Cody Bot',
  version: '2.1.0',
  env: (process.env.NODE_ENV as any) || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  workDir: process.env.WORK_DIR || process.cwd(),
  eventSource: (process.env.EVENT_SOURCE as any) || 'webhook',  // <-- 新增
},
```

**Step 3: Verify changes**

Check that `src/config/schema.ts` has the new `eventSource` field.

---

## Task 3: 实现 WebSocket 事件源

**Files:**
- Create: `src/lark/ws.ts`

**Step 1: Create WebSocket implementation**

```typescript
import { Client } from '@larksuiteoapi/node-sdk';
import type { LarkMessageEvent } from '../types';
import type { EventSource, EventHandler } from './eventsource';
import { getConfig } from '../config';

export class LarkWebSocketSource implements EventSource {
  type = 'websocket' as const;
  private client: any;
  private handler: EventHandler | null = null;
  private wsClient: any;

  constructor() {
    const config = getConfig();
    this.client = new Client({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
    });
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log('[WebSocket] Starting WebSocket client...');

    // Access Lark.WSClient from the SDK
    const Lark = (await import('@larksuiteoapi/node-sdk')) as any;

    if (!Lark.WSClient) {
      throw new Error('WSClient not found in @larksuiteoapi/node-sdk');
    }

    const config = getConfig();
    this.wsClient = new Lark.WSClient({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
    });

    this.wsClient.start({
      eventDispatcher: (event: LarkMessageEvent) => {
        console.log('[WebSocket] Received event:', event.header?.event_type);
        if (this.handler) {
          this.handler(event);
        }
      },
    });

    console.log('[WebSocket] WebSocket client started');
  }

  async stop(): Promise<void> {
    console.log('[WebSocket] Stopping WebSocket client...');
    if (this.wsClient && typeof this.wsClient.stop === 'function') {
      await this.wsClient.stop();
    }
    console.log('[WebSocket] WebSocket client stopped');
  }
}
```

**Step 2: Verify file created**

Check that `src/lark/ws.ts` exists with the above content.

---

## Task 4: 实现 Webhook 事件源包装器

**Files:**
- Create: `src/lark/webhook.ts`

**Step 1: Create Webhook implementation wrapper**

```typescript
import { Hono } from 'hono';
import { gatewayApp } from '../gateway';
import type { LarkMessageEvent } from '../types';
import type { EventSource, EventHandler } from './eventsource';
import { getConfig } from '../config';

export class LarkWebhookSource implements EventSource {
  type = 'webhook' as const;
  private handler: EventHandler | null = null;
  private server: any = null;

  constructor() {
    // We'll patch the gateway to forward events
    this.setupEventForwarding();
  }

  private setupEventForwarding() {
    // The gateway already handles webhook events
    // We'll provide a way to register our handler with the gateway
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler;
    // Store handler globally so gateway can access it
    (globalThis as any).__larkEventHandler = handler;
  }

  async start(): Promise<void> {
    const config = getConfig();
    console.log('[Webhook] Starting HTTP server on port', config.app.port);

    this.server = Bun.serve({
      port: config.app.port,
      fetch: gatewayApp.fetch,
    });

    console.log('[Webhook] HTTP server listening on', this.server.url);
  }

  async stop(): Promise<void> {
    console.log('[Webhook] Stopping HTTP server...');
    if (this.server) {
      this.server.stop();
    }
    console.log('[Webhook] HTTP server stopped');
  }

  // Helper for gateway to call when event is received
  static dispatchEvent(event: LarkMessageEvent) {
    const handler = (globalThis as any).__larkEventHandler;
    if (handler) {
      handler(event);
    }
  }
}
```

**Step 2: Verify file created**

Check that `src/lark/webhook.ts` exists with the above content.

---

## Task 5: 创建事件源工厂

**Files:**
- Create: `src/lark/index.ts` (or update existing `src/lark/client.ts`)
- Modify: `src/lark/client.ts`

**Step 1: Create factory in src/lark/client.ts**

Add to the top of `src/lark/client.ts`:

```typescript
import { getConfig } from '../config';
import type { EventSource } from './eventsource';

export async function createEventSource(): Promise<EventSource> {
  const config = getConfig();

  if (config.app.eventSource === 'websocket') {
    const { LarkWebSocketSource } = await import('./ws');
    return new LarkWebSocketSource();
  } else {
    const { LarkWebhookSource } = await import('./webhook');
    return new LarkWebhookSource();
  }
}
```

Also add exports at the end of the file:

```typescript
export * from './eventsource';
export { createEventSource } from './client';
```

**Step 2: Verify changes**

Check that `src/lark/client.ts` has the new `createEventSource` function.

---

## Task 6: 更新 Gateway 支持事件转发

**Files:**
- Modify: `src/gateway/app.ts`

**Step 1: Update gateway to use event dispatcher**

In `src/gateway/app.ts`, find the `handleMessageEvent` function and modify it to dispatch events:

```typescript
async function handleMessageEvent(
  event: LarkMessageEvent,
  pipeline: ReturnType<typeof createDefaultPipeline>,
  queue: ReturnType<typeof getQueue>,
  db: ReturnType<typeof getDB>
) {
  // Check if we have a global event handler (for WebhookSource)
  const LarkWebhookSource = (await import('../lark/webhook')).LarkWebhookSource;
  if ((globalThis as any).__larkEventHandler) {
    LarkWebhookSource.dispatchEvent(event);
    return;
  }

  // Original webhook processing logic follows...
  const ctx: MiddlewareContext = {
    event,
    extra: {},
    stopped: false,
  };

  // ... rest of existing code
}
```

Wait, actually simpler approach: keep gateway as-is for backward compatibility, and create a separate adapter. Let's simplify this task to just export the handler.

**Step 1 (simplified):** No changes to gateway, keep it working as before. We'll handle dual-mode in the main entry.

---

## Task 7: 更新主入口文件

**Files:**
- Modify: `src/index.ts`

**Step 1: Replace the entire content**

```typescript
import { loadConfig, getConfig } from './config';
import { startWorker, stopWorker } from './worker';
import { startCronScheduler } from './cron';
import { getDB } from './db';
import { initSkills } from './skills';
import { createEventSource } from './lark/client';
import { createDefaultPipeline, type MiddlewareContext } from './middleware';
import { getQueue } from './queue';
import { sendCard } from './lark/client';
import { buildWelcomeCard, buildProgressCard } from './cards';
import { buildContext, extractMessageContent, isMentionedBot } from './utils/context';
import { getBotOpenId } from './lark/client';
import type { LarkMessageEvent } from './types';

// Load config
const config = loadConfig();
const db = getDB();
const queue = getQueue();
const middlewarePipeline = createDefaultPipeline();

console.log('='.repeat(60));
console.log(`${config.app.name} v${config.app.version}`);
console.log('='.repeat(60));
console.log('Environment:', config.app.env);
console.log('Event Source:', config.app.eventSource);
console.log('Worker ID:', config.worker.id);
console.log('Port:', config.app.port);
console.log('Work Dir:', config.app.workDir);
console.log('');

// Initialize skills
initSkills();

// Start worker
const workerEngine = startWorker();

// Start cron scheduler
startCronScheduler();

// Create and start event source
async function main() {
  const eventSource = await createEventSource();

  // Register event handler
  eventSource.onEvent(async (event: LarkMessageEvent) => {
    await handleEvent(event);
  });

  await eventSource.start();

  console.log('');
  console.log('Ready to accept messages!');
}

async function handleEvent(event: LarkMessageEvent) {
  const ctx: MiddlewareContext = {
    event,
    extra: {},
    stopped: false,
  };

  await middlewarePipeline.execute(ctx);

  if (ctx.stopped) {
    console.log('Event stopped by middleware:', ctx.extra);
    return;
  }

  if (!ctx.context || !ctx.content) {
    console.log('Missing context or content');
    return;
  }

  if (isStartCommand(ctx.content)) {
    await sendCard(ctx.context, buildWelcomeCard(), ctx.context.messageId);
    return;
  }

  const taskId = queue.enqueue('message', ctx.context, ctx.content);

  db.createPendingTask(taskId, {
    id: taskId,
    type: 'message',
    context: ctx.context,
    content: ctx.content,
    retryCount: 0,
    maxRetries: 1,
    createdAt: Date.now(),
  });

  const cardMessageId = await sendCard(
    ctx.context,
    buildProgressCard('pending', '任务已加入队列，请稍候...', undefined, taskId),
    ctx.context.messageId
  );

  db.setSetting(`card:${taskId}`, cardMessageId);

  console.log('Task queued:', taskId);
}

function isStartCommand(content: string): boolean {
  const cmd = content.toLowerCase().trim();
  return cmd === 'start' || cmd === '/start' || cmd === '你好' || cmd === 'hello' || cmd === 'help' || cmd === '/help';
}

main().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  stopWorker();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  stopWorker();
  db.close();
  process.exit(0);
});
```

**Step 2: Verify file updated**

Check that `src/index.ts` has the new content.

---

## Task 8: 更新 .env.example

**Files:**
- Modify: `.env.example`

**Step 1: Add EVENT_SOURCE config**

Add at the top or in the service config section:

```bash
# 事件源配置: websocket 或 webhook
EVENT_SOURCE=webhook
```

**Step 2: Verify changes**

Check that `.env.example` has the new `EVENT_SOURCE` option.

---

## Task 9: 更新 README

**Files:**
- Modify: `README.md`

**Step 1: Add WebSocket mode documentation**

Find the "快速开始" section and add:

```bash
# 配置事件源 (可选，默认 webhook)
EVENT_SOURCE=websocket  # 使用长连接模式，无需内网穿透
# 或
EVENT_SOURCE=webhook    # 使用 Webhook 模式，需要 ngrok
```

Also update the architecture section to mention WebSocket support.

**Step 2: Verify changes**

Check that `README.md` has WebSocket mode documented.

---

## Task 10: 测试 WebSocket 模式

**Files:**
- Test: Run the app

**Step 1: Update .env**

Set in `.env`:
```bash
EVENT_SOURCE=websocket
```

**Step 2: Install dependencies**

```bash
bun install
```

**Step 3: Start the app**

```bash
bun run dev
```

Expected output should show:
```
============================================================
Cody Bot v2.1.0
============================================================
Environment: development
Event Source: websocket
Worker ID: ...
...
[WebSocket] Starting WebSocket client...
[WebSocket] WebSocket client started

Ready to accept messages!
```

**Step 4: Verify it runs**

If there are errors about `Lark.WSClient`, we may need to adjust the import.

---

## Summary

This plan implements:
- Unified EventSource interface
- WebSocket implementation using Lark.WSClient
- Webhook wrapper for backward compatibility
- Configuration via EVENT_SOURCE env var
- Updated main entry that works with both modes

The implementation keeps the existing middleware, queue, and worker logic intact—only the event source changes.
