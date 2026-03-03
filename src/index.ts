import { loadConfig, getConfig } from './config';
import { startWorker, stopWorker } from './worker/index';
import { startCronScheduler, handleScheduleCommand, stopAllTasks } from './cron';
import { getDB } from './db';
import { initSkills } from './skills';
import { getSkillLoader } from './skills/loader';
import { createEventSource, shouldUseCard, sendText } from './lark/client';
import { createDefaultPipeline, type MiddlewareContext } from './middleware';
import { getQueue } from './queue';
import { sendCard } from './lark/client';
import { buildWelcomeCard, buildProgressCard } from './cards';
import { logger } from './utils/logger';
import { getMemoryManager } from './session/memory';
import { handleWorkflowTrigger } from './gateway/workflow-trigger';
import type { LarkMessageEvent } from './types';

// 最先加载配置，确保 logger 等其他模块可以使用
loadConfig();

const config = getConfig();
const db = getDB();
const queue = getQueue();
const middlewarePipeline = createDefaultPipeline();
const memoryManager = getMemoryManager();

logger.log('='.repeat(60));
logger.log(`${config.app.name} v${config.app.version}`);
logger.log('='.repeat(60));
logger.log('Environment:', config.app.env);
logger.log('Event Source:', config.app.eventSource);
logger.log('Worker ID:', config.worker.id);
logger.log('Port:', config.app.port);
logger.log('Work Dir:', config.app.workDir);
logger.log('');

initSkills();
getSkillLoader().start();

const workerEngine = startWorker();
startCronScheduler();

async function main() {
  const eventSource = await createEventSource();

  eventSource.onEvent(async (event: LarkMessageEvent) => {
    await handleEvent(event);
  });

  await eventSource.start();

  logger.log('');
  logger.log('Ready to accept messages!');
}

async function handleEvent(event: LarkMessageEvent) {
  logger.log('[Main] handleEvent called with:', JSON.stringify(event, null, 2));

  const ctx: MiddlewareContext = {
    event,
    extra: {},
    stopped: false,
  };

  logger.log('[Main] Starting middleware pipeline...');
  await middlewarePipeline.execute(ctx);

  if (ctx.stopped) {
    logger.log('Event stopped by middleware:', ctx.extra);
    return;
  }

  if (!ctx.context || !ctx.content) {
    logger.log('Missing context or content');
    return;
  }

  if (isStartCommand(ctx.content)) {
    await sendCard(ctx.context, buildWelcomeCard(), ctx.context.messageId);
    return;
  }

  if (ctx.content && await handleScheduleCommand(ctx.content, ctx.context)) {
    return;
  }

  if (await handleAgentIdentityCommand(ctx.content, ctx.context)) {
    return;
  }

  // 检查工作流触发
  if (await handleWorkflowTrigger(ctx.context.userId, ctx.content)) {
    return;
  }

  const taskId = queue.enqueue('message', ctx.context, ctx.content);

  // 对于简单对话，不显示进度卡片，直接让最终结果智能选择模式
  if (isComplexTask(ctx.content)) {
    const cardMessageId = await sendCard(
      ctx.context,
      buildProgressCard('pending', '任务已加入队列，请稍候...', undefined, taskId),
      ctx.context.messageId
    );
    db.setSetting(`card:${taskId}`, cardMessageId);
  }

  logger.log('Task queued:', taskId);
}

function isStartCommand(content: string): boolean {
  const cmd = content.toLowerCase().trim();
  return cmd === 'start' || cmd === '/start' || cmd === '你好' || cmd === 'hello' || cmd === 'help' || cmd === '/help';
}

/**
 * 判断是否是复杂任务（需要显示进度卡片）
 * 简单对话：问候、问答、聊天等
 * 复杂任务：写代码、修改文件、执行命令等
 */
function isComplexTask(content: string): boolean {
  const lowerContent = content.toLowerCase();

  // 包含这些关键词的是复杂任务
  const complexKeywords = [
    '写', '代码', '编程', '修改', '更新', '删除', '创建',
    '实现', '开发', '修复', 'debug', 'fix', 'write', 'code',
    'create', 'delete', 'update', 'modify', 'build', 'implement',
    'git', 'commit', 'push', 'pull', 'merge', 'branch',
    '安装', 'install', 'npm', 'yarn', 'bun', 'pip',
    '运行', '执行', 'run', 'execute', 'command', '命令',
    '文件', 'file', '目录', 'directory', 'folder',
  ];

  for (const keyword of complexKeywords) {
    if (lowerContent.includes(keyword)) {
      return true;
    }
  }

  // 默认是简单对话
  return false;
}

/**
 * 处理更新 agent identity 的命令
 * 格式: "更新角色定位：xxx" 或 "使用memorySkill 更新一下你的角色定位：xxx"
 */
async function handleAgentIdentityCommand(content: string, context: any): Promise<boolean> {
  // 匹配模式：包含"更新角色定位"或"memorySkill"，后面跟着冒号和内容
  const patterns = [
    /更新角色定位[：:]\s*(.+)$/s,
    /memorySkill.*更新.*角色定位[：:]\s*(.+)$/s,
    /使用memorySkill.*更新.*角色定位[：:]\s*(.+)$/s,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const identity = match[1].trim();
      logger.log('[Main] Updating agent identity for user:', context.userId);
      logger.log('[Main] New identity:', identity.substring(0, 200) + '...');

      memoryManager.setAgentIdentity(context.userId, identity);

      await sendText(
        context,
        '✅ 角色定位已更新！下次对话时将使用新的角色定位。',
        context.messageId
      );

      return true;
    }
  }

  return false;
}

main().catch(logger.error);

process.on('SIGINT', async () => {
  logger.log('\nShutting down gracefully...');
  stopWorker();
  stopAllTasks();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.log('\nShutting down gracefully...');
  stopWorker();
  stopAllTasks();
  db.close();
  process.exit(0);
});
