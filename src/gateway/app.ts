// 参考 deer-flow 的 gateway 设计

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { getConfig } from '../config';
import { createDefaultPipeline, type MiddlewareContext } from '../middleware';
import { getQueue } from '../queue';
import { getDB } from '../db';
import { sendCard } from '../lark/client';
import { buildWelcomeCard, buildProgressCard } from '../cards';
import { initSkills, matchSkills } from '../skills';
import type { LarkMessageEvent } from '../types';

export function createGatewayApp(): Hono {
  const config = getConfig();
  const app = new Hono();
  const queue = getQueue();
  const db = getDB();
  const middlewarePipeline = createDefaultPipeline();

  // 初始化技能
  initSkills();

  app.use('*', logger());
  app.use('*', cors());

  // 健康检查
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
      env: config.app.env,
      queueSize: queue.getQueueSize(),
      workerId: config.worker.id,
    });
  });

  // 队列状态
  app.get('/queue', (c) => {
    return c.json({
      size: queue.getQueueSize(),
      pendingIds: queue.getPendingTaskIds(),
    });
  });

  // 技能列表
  app.get('/skills', (c) => {
    const registry = getDB();
    return c.json({
      skills: [],
    });
  });

  // 飞书事件回调 - URL 验证
  app.post('/webhook/event', async (c) => {
    const body = await c.req.json();
    if (body.type === 'url_verification') {
      return c.json({ challenge: body.challenge });
    }
    return c.json({});
  });

  // 飞书事件回调 v2
  app.post('/webhook/event/v2', async (c) => {
    const body = await c.req.json();

    if (body.type === 'url_verification') {
      return c.json({ challenge: body.challenge });
    }

    if (body.header?.event_type === 'im.message.receive_v1') {
      // 检查是否有全局事件处理器（用于 WebhookSource 模式）
      if ((globalThis as any).__larkEventHandler) {
        const { LarkWebhookSource } = await import('../lark/webhook');
        LarkWebhookSource.dispatchEvent(body as LarkMessageEvent);
      } else {
        // 传统 webhook 模式，直接处理
        await handleMessageEvent(body as LarkMessageEvent, middlewarePipeline, queue, db);
      }
    }

    return c.json({});
  });

  return app;
}

async function handleMessageEvent(
  event: LarkMessageEvent,
  pipeline: ReturnType<typeof createDefaultPipeline>,
  queue: ReturnType<typeof getQueue>,
  db: ReturnType<typeof getDB>
) {
  const ctx: MiddlewareContext = {
    event,
    extra: {},
    stopped: false,
  };

  // 执行中间件管道
  await pipeline.execute(ctx);

  if (ctx.stopped) {
    console.log('Event stopped by middleware:', ctx.extra);
    return;
  }

  if (!ctx.context || !ctx.content) {
    console.log('Missing context or content');
    return;
  }

  // 检查是否是欢迎命令
  if (isStartCommand(ctx.content)) {
    await sendCard(ctx.context, buildWelcomeCard(), ctx.context.messageId);
    return;
  }

  // 匹配技能
  const skillMatches = matchSkills(ctx.content);
  const skillIds = skillMatches.map(m => m.skill.id);
  if (skillIds.length > 0) {
    console.log('Matched skills:', skillIds);
  }

  // 入队（带附件）
  const taskId = queue.enqueue('message', ctx.context, ctx.content, ctx.attachments);

  // 创建待处理任务记录（用于崩溃恢复）
  db.createPendingTask(taskId, {
    id: taskId,
    type: 'message',
    context: ctx.context,
    content: ctx.content,
    attachments: ctx.attachments,
    retryCount: 0,
    maxRetries: 1,
    createdAt: Date.now(),
  });

  // 发送进度卡片
  const cardMessageId = await sendCard(
    ctx.context,
    buildProgressCard('pending', '任务已加入队列，请稍候...', undefined, taskId),
    ctx.context.messageId
  );

  db.setSetting(`card:${taskId}`, cardMessageId);
  db.setSetting(`skills:${taskId}`, JSON.stringify(skillIds));

  console.log('Task queued:', taskId, 'skills:', skillIds, 'attachments:', ctx.attachments?.length || 0);
}

function isStartCommand(content: string): boolean {
  const cmd = content.toLowerCase().trim();
  return cmd === 'start' || cmd === '/start' || cmd === '你好' || cmd === 'hello' || cmd === 'help' || cmd === '/help';
}
