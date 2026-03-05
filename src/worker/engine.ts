// 参考 deer-flow 的执行引擎设计

import { getConfig } from '../config';
import { getDB } from '../db';
import { getQueue } from '../queue';
import { TaskExecutor } from './executor';
import { getReflectionEngine } from '../reflection';
import { getEvolutionEngine } from '../evolution';
import type { QueueTask, TaskStatus } from '../types';
import { logger } from '../utils/logger';

export interface WorkerEngineOptions {
  maxConcurrentTasks?: number;
  heartbeatIntervalMs?: number;
  taskTimeoutMs?: number;
}

export class WorkerEngine {
  private config = getConfig();
  private db = getDB();
  private queue = getQueue();
  private executor: TaskExecutor;
  private reflection = getReflectionEngine();
  private evolution = getEvolutionEngine();
  private options: Required<WorkerEngineOptions>;

  private activeTasks = new Map<string, { task: QueueTask; startedAt: number; controller: AbortController }>();
  private heartbeatTimer: Timer | null = null;
  private isRunning = false;

  constructor(options: WorkerEngineOptions = {}) {
    this.options = {
      maxConcurrentTasks: options.maxConcurrentTasks ?? this.config.worker.maxConcurrentTasks,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? this.config.worker.heartbeatIntervalMs,
      taskTimeoutMs: options.taskTimeoutMs ?? this.config.worker.taskTimeoutMs,
    };

    this.executor = new TaskExecutor();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[WorkerEngine] Starting...');
    logger.info('[WorkerEngine] Worker ID:', this.config.worker.id);
    logger.info('[WorkerEngine] Max concurrent tasks:', this.options.maxConcurrentTasks);

    this.recoverTasks();
    this.registerQueueHandler();
    this.startHeartbeat();

    logger.info('[WorkerEngine] Started');
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    logger.info('[WorkerEngine] Stopping...');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    logger.info('[WorkerEngine] Stopped');
  }

  private recoverTasks() {
    logger.info('[WorkerEngine] Recovering stuck tasks...');

    const stuckTasks = this.db.getStuckTasks();

    for (const stuckTask of stuckTasks) {
      logger.info('[WorkerEngine] Recovering stuck task:', stuckTask.taskId);
      // 对于卡住的任务，我们将其状态重置为 pending 并重新入队
      // 注意：这可能会导致任务重复执行，需要确保任务是幂等的
      // 对于像 "bun run dev" 这种可能导致重启的任务，重启后恢复是合理的
      this.db.updatePendingTaskStatus(stuckTask.taskId, 'pending');
      this.queue.recover(stuckTask.task);
    }

    const pendingTasks = this.db.getPendingTasks('pending');

    for (const pendingTask of pendingTasks) {
      logger.info('[WorkerEngine] Requeuing pending task:', pendingTask.taskId);
      // 恢复 pending 任务到内存队列
      this.queue.recover(pendingTask.task);
    }

    logger.info('[WorkerEngine] Recovery complete');
  }

  private registerQueueHandler() {
    this.queue.registerHandler(async (task) => {
      await this.processTask(task);
    });
  }

  /**
   * The Core Metacognitive Loop
   */
  private async processTask(task: QueueTask) {
    if (!this.isRunning) return;

    // 检查并发限制
    while (this.activeTasks.size >= this.options.maxConcurrentTasks) {
      await new Promise(r => setTimeout(r, 100));
    }

    const taskId = task.id;
    const startedAt = Date.now();
    const controller = new AbortController();

    this.activeTasks.set(taskId, { task, startedAt, controller });
    this.db.updatePendingTaskStatus(taskId, 'processing', this.config.worker.id);

    try {
      // --- Phase 1: Orient (Pre-Task) ---
      // TODO: Query memory for relevant facts/skills here
      // For now, we trust the Executor to handle prompt injection via Skills
      
      // --- Phase 2: Act (Execution) ---
      // 传递 onComplete 回调，以便 Executor 在内部决定是否触发详细的评估/反思
      // 注意：Executor 内部已经实现了 "Simple Task" 检测逻辑。
      // 如果是 Simple Task，它不会调用 onComplete。
      // 如果是 Complex Task，它会调用 onComplete 触发 Evaluator。
      
      // 我们在这里只负责基础的 DB 状态更新和错误捕获，不再强制触发 Reflection。
      // 真正的元认知闭环逻辑下放给 Executor 控制，因为它知道任务的输出和上下文。
      
      await this.executor.execute(task, {
          signal: controller.signal,
          onComplete: async (taskId, success, output, duration) => {
              // 只有当 Executor 认为值得反思时（即非简单任务），才会回调这里
              // 此时我们可以安全地进行深度反思
              const taskResult = {
                taskId,
                taskContent: task.content,
                success,
                output,
                duration
              };
              
              // 触发反思（合并式：评分 + 洞察 + 行动建议 只需 1 次 LLM 调用）
              const reflection = await this.reflection.analyze(taskResult);
              if (reflection && reflection.actionableItem) {
                  logger.info(`[Metacognition] Insight: ${reflection.content}`);

                  // 将反思洞察写入 Soul 成长记录
                  try {
                    const { getSoulManager } = await import('../soul');
                    const soulMgr = getSoulManager();
                    soulMgr.appendGrowth(task.agentId || 'default', reflection.content);
                  } catch (e) {
                    logger.debug(`[Metacognition] Soul growth append skipped:`, e);
                  }
                  
                  const item = reflection.actionableItem;
                  if (item.startsWith('Create skill:')) {
                    // 评估结果建议创建技能 → 交给 EvolutionEngine（使用兼容包装器）
                    this.evolution.evolveFromInsight(item.replace('Create skill:', '').trim()).catch(e => logger.error(e));
                  } else if (item.startsWith('Update memory:')) {
                    // 评估结果建议更新记忆 → 保存到长期记忆
                    const memoryContent = item.replace('Update memory:', '').trim();
                    logger.info(`[Metacognition] Applying memory update: ${memoryContent}`);
                    try {
                      const { getLongTermMemoryManager } = await import('../session/long_term_memory');
                      const ltm = getLongTermMemoryManager();
                      if (task.context?.userId) {
                        ltm.addFact(task.context.userId, memoryContent, 1.0);
                        logger.info(`[Metacognition] Memory updated for user ${task.context.userId}`);
                      }
                    } catch (err) {
                      logger.error(`[Metacognition] Failed to update memory:`, err);
                    }
                  }
              }
          }
      });

      // --- Phase 3: Reflect (Post-Task) ---
      // 旧逻辑已移除，改为由 Executor 的回调驱动。
      // 这样就避免了 "Simple Task" 被跳过后，Engine 层又强制跑一遍 Reflection 的问题。

      this.db.updatePendingTaskStatus(taskId, 'completed');
      this.db.removePendingTask(taskId);
    } catch (error) {
      logger.error('[WorkerEngine] Task failed:', taskId, error);
      
      // Reflect on failure
      const taskResult = {
        taskId,
        taskContent: task.content,
        success: false,
        output: "",
        error: String(error),
        duration: Date.now() - startedAt
      };
      await this.reflection.analyze(taskResult);

      this.db.updatePendingTaskStatus(taskId, 'failed');
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const [taskId, { task, startedAt }] of this.activeTasks) {
        this.db.heartbeat(taskId);

        if (now - startedAt > this.options.taskTimeoutMs) {
          logger.warn('[WorkerEngine] Task timeout:', taskId);
          this.handleTimeout(taskId, task);
        }
      }
    }, this.options.heartbeatIntervalMs);
  }

  private handleTimeout(taskId: string, task: QueueTask) {
    const entry = this.activeTasks.get(taskId);
    if (entry) {
        logger.warn('[WorkerEngine] Aborting task:', taskId);
        entry.controller.abort();
    }
    this.db.updatePendingTaskStatus(taskId, 'timeout');
    this.activeTasks.delete(taskId);
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  getActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }
}
