import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

const config = getConfig();

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface MessageEvent {
  type: string;
  timestamp: string;
  message?: {
    role: string;
  };
  usage?: UsageStats;
}

export interface DailyStats {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  assistantMessageCount: number;
  userMessageCount: number;
  totalSessionCount: number;
  sessions: Array<{
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    messageCount: number;
  }>;
}

function getSessionsDir(): string {
  const workDir = config.app.workDir;
  return join(workDir, 'agents', 'sessions');
}

function getDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function calculateDailyStats(targetDate?: string): DailyStats {
  const dateStr = targetDate || getDateString(new Date());
  const sessionsDir = getSessionsDir();

  const stats: DailyStats = {
    date: dateStr,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    assistantMessageCount: 0,
    userMessageCount: 0,
    totalSessionCount: 0,
    sessions: [],
  };

  if (!existsSync(sessionsDir)) {
    logger.warn('[DailyStats] Sessions directory not found:', sessionsDir);
    return stats;
  }

  const files = readdirSync(sessionsDir).filter(
    (f) => f.endsWith('.jsonl') && f.includes(dateStr)
  );

  stats.totalSessionCount = files.length;

  for (const file of files) {
    const sessionId = file.replace(`${dateStr}_`, '').replace('.jsonl', '');
    const filePath = join(sessionsDir, file);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      let sessionInput = 0;
      let sessionOutput = 0;
      let sessionTotal = 0;
      let sessionCost = 0;
      let sessionMsgCount = 0;

      for (const line of lines) {
        try {
          const msg: MessageEvent = JSON.parse(line);

          if (msg.type === 'message') {
            if (msg.message?.role === 'user') {
              stats.userMessageCount++;
            }

            if (msg.message?.role === 'assistant' && msg.usage) {
              const usage = msg.usage;
              stats.totalInputTokens += usage.input;
              stats.totalOutputTokens += usage.output;
              stats.totalCacheReadTokens += usage.cacheRead || 0;
              stats.totalCacheWriteTokens += usage.cacheWrite || 0;
              stats.totalTokens += usage.totalTokens;
              stats.totalCostUsd += usage.cost.total || 0;
              stats.assistantMessageCount++;

              sessionInput += usage.input;
              sessionOutput += usage.output;
              sessionTotal += usage.totalTokens;
              sessionCost += usage.cost.total || 0;
              sessionMsgCount++;
            }
          }
        } catch {
          // skip invalid lines
        }
      }

      if (sessionMsgCount > 0) {
        stats.sessions.push({
          sessionId,
          inputTokens: sessionInput,
          outputTokens: sessionOutput,
          totalTokens: sessionTotal,
          costUsd: sessionCost,
          messageCount: sessionMsgCount,
        });
      }
    } catch (error) {
      logger.error('[DailyStats] Failed to read file:', file, error);
    }
  }

  return stats;
}

export function formatStatsReport(stats: DailyStats): string {
  const lines: string[] = [];

  lines.push(`📊 **每日统计报告 - ${stats.date}**`);
  lines.push('');
  lines.push('🔢 **消息统计**');
  lines.push(`   • 用户消息: ${stats.userMessageCount.toLocaleString()}`);
  lines.push(`   • 助手消息: ${stats.assistantMessageCount.toLocaleString()}`);
  lines.push(`   • 会话数量: ${stats.totalSessionCount.toLocaleString()}`);
  lines.push('');
  lines.push('💰 **Token 使用**');
  lines.push(`   • 输入 Token: ${stats.totalInputTokens.toLocaleString()}`);
  lines.push(`   • 输出 Token: ${stats.totalOutputTokens.toLocaleString()}`);
  lines.push(`   • 缓存读取: ${stats.totalCacheReadTokens.toLocaleString()}`);
  lines.push(`   • 缓存写入: ${stats.totalCacheWriteTokens.toLocaleString()}`);
  lines.push(`   • **总计 Token**: ${stats.totalTokens.toLocaleString()}`);
  lines.push('');
  lines.push(`💸 **总成本**: $${stats.totalCostUsd.toFixed(4)}`);

  if (stats.sessions.length > 0) {
    lines.push('');
    lines.push('📋 **各会话详情**:');
    for (const session of stats.sessions.slice(0, 10)) {
      lines.push(
        `   • ${session.sessionId.slice(0, 8)}...: ` +
          `${session.totalTokens.toLocaleString()} tokens, ` +
          `$${session.costUsd.toFixed(4)}, ` +
          `${session.messageCount} 条消息`
      );
    }
    if (stats.sessions.length > 10) {
      lines.push(`   ... 还有 ${stats.sessions.length - 10} 个会话`);
    }
  }

  return lines.join('\n');
}
