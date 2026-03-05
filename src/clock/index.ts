import { getDB } from '../db';
import { logger } from '../utils/logger';
import { getEvolutionEngine } from '../evolution';

/**
 * ThinkingClock — 后台定时巡检器
 * 
 * 重构说明：
 * 旧设计：每 60 分钟扫描 reflections → 调用 LLM 分析 → 再调用 LLM 生成 SkillSpec → 创建技能
 *   问题：2 次额外 LLM 调用，成本高，且与 onComplete 实时路径重复
 * 
 * 新设计：ThinkingClock 不再调用 LLM，只做 "执行层"
 * - 反思和行动建议已在 Executor → Evaluator 阶段一步到位产出
 * - ThinkingClock 只负责扫描未执行的 actionable_item 并执行它们
 * - 这样整条链路从 4 次 LLM 调用降为 1 次（仅 Evaluator 合并式调用）
 * 
 * v2 新增：Heartbeat 策展（对标 OpenClaw HEARTBEAT.md）
 * - 每次 tick 额外执行 DailyLog → Soul.memories 的策展
 * - 重读 Soul 文件，保持人格一致性
 */
export class ThinkingClock {
  private db = getDB();
  private evolution = getEvolutionEngine();
  private timer: Timer | null = null;
  private isThinking = false;

  constructor(private intervalMs: number = 60 * 60 * 1000) {}

  start() {
    if (this.timer) return;
    logger.info(`[ThinkingClock] Started (interval: ${this.intervalMs / 60000}min)`);

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[ThinkingClock] Stopped');
  }

  private async tick() {
    if (this.isThinking) {
      logger.info('[ThinkingClock] Already running, skipping');
      return;
    }
    this.isThinking = true;

    try {
      logger.info('[ThinkingClock] 🧠 Starting background cycle...');
      await this.executePendingActions();
      await this.heartbeatCuration();
      logger.info('[ThinkingClock] 🧠 Cycle complete');
    } catch (e) {
      logger.error('[ThinkingClock] Error:', e);
    } finally {
      this.isThinking = false;
    }
  }

  /**
   * 扫描未处理的 reflections，执行其中的 actionable_item
   * 不调用 LLM — action 已在 Evaluator 阶段确定
   */
  private async executePendingActions() {
    // 确保 processed 列存在
    try {
      this.db['db'].run(`ALTER TABLE reflections ADD COLUMN processed INTEGER DEFAULT 0`);
    } catch (e) { /* 列已存在 */ }

    // 取未处理的、有 actionable_item 的 reflections（最多 3 条）
    const pending = this.db['db'].query(`
      SELECT * FROM reflections
      WHERE actionable_item IS NOT NULL
      AND actionable_item != ''
      AND (processed IS NULL OR processed = 0)
      AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 3
    `).all(Date.now() - 7 * 24 * 60 * 60 * 1000) as any[];

    if (pending.length === 0) {
      logger.info('[ThinkingClock] No pending actions');
      return;
    }

    for (const ref of pending) {
      const item: string = ref.actionable_item;
      logger.info(`[ThinkingClock] Executing action: "${item.slice(0, 80)}"`);

      try {
        if (item.startsWith('Create skill:')) {
          const desc = item.replace('Create skill:', '').trim();
          // acquireCapability 内部会调用 1 次 LLM 生成 SkillSpec（这是必要的）
          await this.evolution.acquireCapability(desc);
        } else if (item.startsWith('Update memory:')) {
          const memContent = item.replace('Update memory:', '').trim();
          logger.info(`[ThinkingClock] Applying memory update: ${memContent}`);
          try {
            const { getLongTermMemoryManager } = await import('../session/long_term_memory');
            const ltm = getLongTermMemoryManager();
            // 从 reflection 关联的 task 中找 userId
            const taskRow = this.db['db'].query(
              `SELECT t.userId FROM pending_tasks t JOIN reflections r ON r.task_id = t.id WHERE r.id = ? LIMIT 1`
            ).get(ref.id) as any;
            if (taskRow?.userId) {
              ltm.addFact(taskRow.userId, memContent, 1.0);
              logger.info(`[ThinkingClock] Memory updated for user ${taskRow.userId}`);
            } else {
              logger.warn(`[ThinkingClock] No userId found for memory update, skipping: ${memContent.slice(0, 50)}`);
            }
          } catch (err) {
            logger.error(`[ThinkingClock] Failed to update memory:`, err);
          }
        } else {
          // 旧格式的 actionable_item（不带前缀）— 尝试匹配关键词
          if (item.toLowerCase().includes('skill') || item.toLowerCase().includes('create')) {
            await this.evolution.acquireCapability(item);
          } else {
            logger.info(`[ThinkingClock] Unrecognized action format, skipping: "${item.slice(0, 60)}"`);
          }
        }
      } catch (e) {
        logger.error(`[ThinkingClock] Failed to execute action:`, e);
      } finally {
        // 标记为已处理
        this.db['db'].run(`UPDATE reflections SET processed = 1 WHERE id = ?`, [ref.id]);
      }
    }
  }

  /**
   * Heartbeat 策展 — 对标 OpenClaw HEARTBEAT.md
   * 
   * 每次 tick 执行：
   * 1. 重读 Soul 文件（保持人格一致性）
   * 2. 扫描最近 DailyLog，提取摘要写入 Soul.memories
   * 3. 清理过期的 DailyLog（保留最近 30 天）
   */
  private async heartbeatCuration() {
    try {
      // 1. 刷新 Soul 缓存（确保 Agent 使用最新的 Soul 文件）
      try {
        const { getSoulManager } = await import('../soul');
        const soulMgr = getSoulManager();
        // 强制重读：清除缓存后获取
        (soulMgr as any).cache?.clear?.();
        const soul = soulMgr.getSoul('default');
        logger.info(`[Heartbeat] Soul refreshed: v${soul.version}`);
      } catch (e) {
        logger.debug('[Heartbeat] Soul refresh skipped:', e);
      }

      // 1b. 刷新 Agents 缓存（确保 Agent 定义热更新生效）
      try {
        const { getAgentsManager } = await import('../workspace/agents');
        getAgentsManager().clearCache();
        logger.info('[Heartbeat] Agents cache refreshed');
      } catch (e) {
        logger.debug('[Heartbeat] Agents cache refresh skipped:', e);
      }

      // 2. 扫描 DailyLog，提取摘要
      try {
        const { getDailyLogManager } = await import('../workspace/daily-log');
        const dlm = getDailyLogManager();
        const recentLogs = dlm.getRecentLogs(1); // 只看今天的

        if (recentLogs.length > 0) {
          const todayLog = recentLogs[0];
          const entryCount = (todayLog.content.match(/^### /gm) || []).length;

          if (entryCount > 0) {
            // 将今日摘要写入 Soul.memories
            try {
              const { getSoulManager } = await import('../soul');
              const soulMgr = getSoulManager();
              soulMgr.appendMemory('default', `[${todayLog.date}] 今日 ${entryCount} 条交互记录`);
              logger.info(`[Heartbeat] Curated ${entryCount} entries from ${todayLog.date} into Soul.memories`);
            } catch (e) {
              logger.debug('[Heartbeat] Soul memory append skipped:', e);
            }
          }
        }
      } catch (e) {
        logger.debug('[Heartbeat] DailyLog curation skipped:', e);
      }

      // 3. 清理过期 DailyLog 文件（保留最近 30 天）
      try {
        const { getDailyLogManager } = await import('../workspace/daily-log');
        const dlm = getDailyLogManager();
        const allFiles = dlm.listLogFiles();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 30);
        const cutoffStr = cutoffDate.toISOString().split('T')[0];

        const fs = await import('fs');
        const path = await import('path');
        let cleaned = 0;
        for (const file of allFiles) {
          const dateStr = file.replace('.md', '');
          if (dateStr < cutoffStr) {
            const filePath = path.join((dlm as any).memoryDir, file);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              cleaned++;
            }
          }
        }
        if (cleaned > 0) {
          logger.info(`[Heartbeat] Cleaned ${cleaned} expired daily log files`);
        }
      } catch (e) {
        logger.debug('[Heartbeat] DailyLog cleanup skipped:', e);
      }

    } catch (e) {
      logger.error('[Heartbeat] Curation error:', e);
    }
  }
}

let clockInstance: ThinkingClock | null = null;

export function getThinkingClock(): ThinkingClock {
  if (!clockInstance) {
    clockInstance = new ThinkingClock();
  }
  return clockInstance;
}
