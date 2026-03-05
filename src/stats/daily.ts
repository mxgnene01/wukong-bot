import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
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
  // Token 统计（来自 JSONL usage 字段）
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  // 消息统计（双源聚合：JSONL 为主，DB 补充）
  assistantMessageCount: number;
  userMessageCount: number;
  totalSessionCount: number;
  // 数据来源标记
  dataSource: 'jsonl' | 'db' | 'merged';
  sessions: Array<{
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    messageCount: number;
    userMsgCount: number;
    assistantMsgCount: number;
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

// ──── 数据源 1：JSONL 会话文件 ────
function collectFromJsonl(dateStr: string): {
  userCount: number;
  assistantCount: number;
  sessionCount: number;
  tokenStats: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    totalTokens: number; costUsd: number;
  };
  sessions: DailyStats['sessions'];
} {
  const sessionsDir = getSessionsDir();
  const result = {
    userCount: 0,
    assistantCount: 0,
    sessionCount: 0,
    tokenStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
    sessions: [] as DailyStats['sessions'],
  };

  if (!existsSync(sessionsDir)) {
    logger.warn('[DailyStats] Sessions directory not found:', sessionsDir);
    return result;
  }

  const files = readdirSync(sessionsDir).filter(
    (f) => f.endsWith('.jsonl') && f.includes(dateStr)
  );

  result.sessionCount = files.length;

  for (const file of files) {
    const sessionId = file.replace(`${dateStr}_`, '').replace('.jsonl', '');
    const filePath = join(sessionsDir, file);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      let sInput = 0, sOutput = 0, sTotal = 0, sCost = 0;
      let sUserMsg = 0, sAssistantMsg = 0;

      for (const line of lines) {
        try {
          const msg: MessageEvent = JSON.parse(line);
          if (msg.type === 'message') {
            if (msg.message?.role === 'user') {
              result.userCount++;
              sUserMsg++;
            }
            if (msg.message?.role === 'assistant') {
              result.assistantCount++;
              sAssistantMsg++;

              if (msg.usage) {
                const u = msg.usage;
                result.tokenStats.input += u.input || 0;
                result.tokenStats.output += u.output || 0;
                result.tokenStats.cacheRead += u.cacheRead || 0;
                result.tokenStats.cacheWrite += u.cacheWrite || 0;
                result.tokenStats.totalTokens += u.totalTokens || 0;
                result.tokenStats.costUsd += u.cost?.total || 0;

                sInput += u.input || 0;
                sOutput += u.output || 0;
                sTotal += u.totalTokens || 0;
                sCost += u.cost?.total || 0;
              }
            }
          }
        } catch {
          // skip invalid lines
        }
      }

      if (sAssistantMsg > 0 || sTotal > 0) {
        result.sessions.push({
          sessionId, inputTokens: sInput, outputTokens: sOutput,
          totalTokens: sTotal, costUsd: sCost,
          messageCount: sUserMsg + sAssistantMsg,
          userMsgCount: sUserMsg, assistantMsgCount: sAssistantMsg,
        });
      }
    } catch (error) {
      logger.error('[DailyStats] Failed to read JSONL file:', file, error);
    }
  }
  return result;
}

// ──── 数据源 2：SQLite sessions 表 ────
function collectFromDB(dateStr: string): {
  userCount: number;
  assistantCount: number;
  sessionCount: number;
  sessions: Array<{
    sessionId: string;
    userMsgCount: number;
    assistantMsgCount: number;
  }>;
} {
  const result = {
    userCount: 0,
    assistantCount: 0,
    sessionCount: 0,
    sessions: [] as Array<{ sessionId: string; userMsgCount: number; assistantMsgCount: number }>,
  };

  try {
    const dbPath = join(config.app.workDir, 'data', 'wukong.db');
    if (!existsSync(dbPath)) {
      logger.warn('[DailyStats] DB file not found:', dbPath);
      return result;
    }
    const db = new Database(dbPath, { readonly: true });

    // 计算日期范围的毫秒时间戳
    const dayStart = new Date(dateStr + 'T00:00:00').getTime();
    const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();

    // 查询当日有更新的会话
    const stmt = db.prepare(
      'SELECT sessionId, history, createdAt, updatedAt FROM sessions WHERE updatedAt >= ? AND updatedAt <= ?'
    );
    const rows = stmt.all(dayStart, dayEnd) as any[];

    result.sessionCount = rows.length;

    for (const row of rows) {
      try {
        const history = JSON.parse(row.history) as Array<{ role: string; content: string }>;
        let uCount = 0, aCount = 0;

        for (const msg of history) {
          if (msg.role === 'user') uCount++;
          else if (msg.role === 'assistant') aCount++;
        }

        result.userCount += uCount;
        result.assistantCount += aCount;
        result.sessions.push({
          sessionId: row.sessionId,
          userMsgCount: uCount,
          assistantMsgCount: aCount,
        });
      } catch {
        // skip invalid history
      }
    }

    db.close();
  } catch (error) {
    logger.error('[DailyStats] Failed to query DB:', error);
  }

  return result;
}

// ──── 双源聚合 ────
export function calculateDailyStats(targetDate?: string): DailyStats {
  const dateStr = targetDate || getDateString(new Date());

  // 从两个数据源收集
  const jsonl = collectFromJsonl(dateStr);
  const dbData = collectFromDB(dateStr);

  // 聚合策略：
  // - 消息计数：取两个数据源的较大值（DB 可能包含 JSONL 未记录的历史消息）
  // - Token 统计：只有 JSONL 有（DB 不存 usage）
  // - 会话数：取较大值
  const userMsgCount = Math.max(jsonl.userCount, dbData.userCount);
  const assistantMsgCount = Math.max(jsonl.assistantCount, dbData.assistantCount);
  const sessionCount = Math.max(jsonl.sessionCount, dbData.sessionCount);

  // 判断数据来源
  let dataSource: DailyStats['dataSource'] = 'jsonl';
  if (jsonl.sessionCount === 0 && dbData.sessionCount > 0) {
    dataSource = 'db';
  } else if (jsonl.sessionCount > 0 && dbData.sessionCount > 0) {
    dataSource = 'merged';
  }

  // 合并会话详情：以 JSONL sessions 为基础，DB 数据补充消息计数
  const mergedSessions = [...jsonl.sessions];
  for (const dbSession of dbData.sessions) {
    const existing = mergedSessions.find(s => s.sessionId === dbSession.sessionId);
    if (existing) {
      // DB 有更完整的消息计数时，用 DB 的
      existing.userMsgCount = Math.max(existing.userMsgCount, dbSession.userMsgCount);
      existing.assistantMsgCount = Math.max(existing.assistantMsgCount, dbSession.assistantMsgCount);
      existing.messageCount = existing.userMsgCount + existing.assistantMsgCount;
    } else {
      // DB 中有但 JSONL 中没有的会话
      mergedSessions.push({
        sessionId: dbSession.sessionId,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
        messageCount: dbSession.userMsgCount + dbSession.assistantMsgCount,
        userMsgCount: dbSession.userMsgCount,
        assistantMsgCount: dbSession.assistantMsgCount,
      });
    }
  }

  return {
    date: dateStr,
    totalInputTokens: jsonl.tokenStats.input,
    totalOutputTokens: jsonl.tokenStats.output,
    totalCacheReadTokens: jsonl.tokenStats.cacheRead,
    totalCacheWriteTokens: jsonl.tokenStats.cacheWrite,
    totalTokens: jsonl.tokenStats.totalTokens,
    totalCostUsd: jsonl.tokenStats.costUsd,
    assistantMessageCount: assistantMsgCount,
    userMessageCount: userMsgCount,
    totalSessionCount: sessionCount,
    dataSource,
    sessions: mergedSessions,
  };
}

// ──── 报告格式化 ────
export function formatStatsReport(stats: DailyStats): string {
  const lines: string[] = [];

  lines.push('📊 每日统计报告');
  lines.push('');
  lines.push(`日期: ${stats.date}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('🔢 消息统计');
  lines.push(`• 用户消息: ${stats.userMessageCount.toLocaleString()}`);
  lines.push(`• 助手消息: ${stats.assistantMessageCount.toLocaleString()}`);
  lines.push(`• 会话数量: ${stats.totalSessionCount.toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('💰 Token 使用');
  lines.push(`• 输入: ${stats.totalInputTokens.toLocaleString()}`);
  lines.push(`• 输出: ${stats.totalOutputTokens.toLocaleString()}`);
  lines.push(`• 缓存读取: ${stats.totalCacheReadTokens.toLocaleString()}`);
  lines.push(`• 缓存写入: ${stats.totalCacheWriteTokens.toLocaleString()}`);
  lines.push(`• 总计: ${stats.totalTokens.toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('💸 总成本');
  lines.push('');
  lines.push(`$${stats.totalCostUsd.toFixed(4)}`);

  // Token 数据缺失提示
  if (stats.assistantMessageCount > 0 && stats.totalTokens === 0) {
    lines.push('');
    lines.push('> ⚠️ 有助手消息但无 Token 数据。历史消息的 usage 字段缺失，新消息将自动采集。');
  }

  // 数据来源说明
  const sourceLabel = stats.dataSource === 'merged' ? 'JSONL + DB' :
                      stats.dataSource === 'db' ? '仅 DB' : '仅 JSONL';
  lines.push('');
  lines.push(`📋 数据来源: ${sourceLabel}`);

  // 会话详情
  if (stats.sessions.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('📋 各会话详情');
    for (const session of stats.sessions.slice(0, 10)) {
      const tokenInfo = session.totalTokens > 0
        ? `${session.totalTokens.toLocaleString()} tokens, $${session.costUsd.toFixed(4)}`
        : '无 Token 数据';
      lines.push(
        `• ${session.sessionId.slice(0, 20)}...: ` +
        `${session.messageCount} 条消息 (👤${session.userMsgCount} 🤖${session.assistantMsgCount}), ${tokenInfo}`
      );
    }
    if (stats.sessions.length > 10) {
      lines.push(`... 还有 ${stats.sessions.length - 10} 个会话`);
    }
  }

  lines.push('');
  lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`);

  return lines.join('\n');
}
