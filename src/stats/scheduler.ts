import cron from 'node-cron';
import { getDB } from '../db';
import { calculateDailyStats, formatStatsReport } from './daily';
import { buildDailyStatsCard } from '../cards';
import { sendCard, sendText } from '../lark/client';
import { logger } from '../utils/logger';
import type { ChatContext } from '../types';

const SETTING_KEY_DAILY_STATS_CONTEXT = 'daily_stats:context';
const SETTING_KEY_DAILY_STATS_ENABLED = 'daily_stats:enabled';

let dailyStatsJob: cron.ScheduledTask | null = null;

export function getDailyStatsContext(): ChatContext | null {
  const db = getDB();
  const contextJson = db.getSetting(SETTING_KEY_DAILY_STATS_CONTEXT);
  if (!contextJson) {
    return null;
  }
  try {
    return JSON.parse(contextJson);
  } catch {
    return null;
  }
}

export function setDailyStatsContext(context: ChatContext): void {
  const db = getDB();
  db.setSetting(SETTING_KEY_DAILY_STATS_CONTEXT, JSON.stringify(context));
  logger.info('[DailyStats] Notification context saved');
}

export function isDailyStatsEnabled(): boolean {
  const db = getDB();
  const enabled = db.getSetting(SETTING_KEY_DAILY_STATS_ENABLED);
  return enabled === 'true';
}

export function setDailyStatsEnabled(enabled: boolean): void {
  const db = getDB();
  db.setSetting(SETTING_KEY_DAILY_STATS_ENABLED, enabled ? 'true' : 'false');
  logger.info('[DailyStats] Enabled set to:', enabled);
}

export async function sendDailyStatsReport(): Promise<void> {
  const context = getDailyStatsContext();
  if (!context) {
    logger.warn('[DailyStats] No notification context configured');
    return;
  }

  try {
    const stats = calculateDailyStats();
    logger.info('[DailyStats] Calculated stats:', {
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCostUsd,
      messages: stats.assistantMessageCount,
    });

    if (stats.assistantMessageCount === 0 && stats.userMessageCount === 0) {
      logger.info('[DailyStats] No activity today, sending simple message');
      await sendText(context, `📊 每日统计 (${stats.date})\n\n今日没有活动记录。`);
      return;
    }

    // 发送卡片
    await sendCard(context, buildDailyStatsCard(stats));
    logger.info('[DailyStats] Report sent successfully');
  } catch (error) {
    logger.error('[DailyStats] Failed to send report:', error);
    // 尝试发送简单文本消息
    try {
      await sendText(context, `❌ 每日统计报告生成失败: ${error}`);
    } catch {
      // ignore
    }
  }
}

export function startDailyStatsScheduler(): void {
  if (dailyStatsJob) {
    dailyStatsJob.stop();
    dailyStatsJob = null;
  }

  if (!isDailyStatsEnabled()) {
    logger.info('[DailyStats] Daily stats not enabled, skipping scheduler');
    return;
  }

  const context = getDailyStatsContext();
  if (!context) {
    logger.warn('[DailyStats] No notification context, skipping scheduler');
    return;
  }

  // 每天 23:00 执行
  const cronExpression = '0 23 * * *';

  if (!cron.validate(cronExpression)) {
    logger.error('[DailyStats] Invalid cron expression:', cronExpression);
    return;
  }

  dailyStatsJob = cron.schedule(cronExpression, () => {
    logger.info('[DailyStats] Triggering daily stats report...');
    sendDailyStatsReport().catch((err) => {
      logger.error('[DailyStats] Error in scheduled task:', err);
    });
  });

  logger.info('[DailyStats] Scheduler started (daily at 23:00)');
}

export function stopDailyStatsScheduler(): void {
  if (dailyStatsJob) {
    dailyStatsJob.stop();
    dailyStatsJob = null;
    logger.info('[DailyStats] Scheduler stopped');
  }
}

export function refreshDailyStatsScheduler(): void {
  stopDailyStatsScheduler();
  startDailyStatsScheduler();
}

// 手动触发统计（用于测试）
export async function triggerDailyStatsManually(context?: ChatContext): Promise<string> {
  const targetContext = context || getDailyStatsContext();
  if (!targetContext) {
    return '❌ 没有配置通知上下文，请先设置每日统计。';
  }

  const stats = calculateDailyStats();
  return formatStatsReport(stats);
}
