// 参考 deer-flow 的执行引擎设计

import { getConfig } from '../config';
import { getDB } from '../db';
import { getQueue } from '../queue';
import { TaskExecutor } from './executor';
import type { QueueTask, TaskStatus } from '../types';

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
  private options: Required<WorkerEngineOptions>;

  private activeTasks = new Map<string, { task: QueueTask; startedAt: number }>();
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

    console.log('[WorkerEngine] Starting...');
    console.log('[WorkerEngine] Worker ID:', this.config.worker.id);
    console.log('[WorkerEngine] Max concurrent tasks:', this.options.maxConcurrentTasks);

    this.recoverTasks();
    this.registerQueueHandler();
    this.startHeartbeat();

    console.log('[WorkerEngine] Started');
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    console.log('[WorkerEngine] Stopping...');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    console.log('[WorkerEngine] Stopped');
  }

  private recoverTasks() {
    console.log('[WorkerEngine] Recovering stuck tasks...');

    const stuckTasks = this.db.getStuckTasks();

    for (const stuckTask of stuckTasks) {
      console.log('[WorkerEngine] Recovering stuck task:', stuckTask.taskId);
      // 对于卡住的任务，我们将其状态重置为 pending 并重新入队
      // 注意：这可能会导致任务重复执行，需要确保任务是幂等的
      // 对于像 "bun run dev" 这种可能导致重启的任务，重启后恢复是合理的
      this.db.updatePendingTaskStatus(stuckTask.taskId, 'pending');
      this.queue.recover(stuckTask.task);
    }

    const pendingTasks = this.db.getPendingTasks('pending');

    for (const pendingTask of pendingTasks) {
      console.log('[WorkerEngine] Requeuing pending task:', pendingTask.taskId);
      // 恢复 pending 任务到内存队列
      this.queue.recover(pendingTask.task);
    }

    console.log('[WorkerEngine] Recovery complete');
  }

  private registerQueueHandler() {
    this.queue.registerHandler(async (task) => {
      await this.processTask(task);
    });
  }

  private async processTask(task: QueueTask) {
    if (!this.isRunning) return;

    // 检查并发限制
    while (this.activeTasks.size >= this.options.maxConcurrentTasks) {
      await new Promise(r => setTimeout(r, 100));
    }

    const taskId = task.id;
    const startedAt = Date.now();

    this.activeTasks.set(taskId, { task, startedAt });
    this.db.updatePendingTaskStatus(taskId, 'processing', this.config.worker.id);

    try {
      await this.executor.execute(task);

      this.db.updatePendingTaskStatus(taskId, 'completed');
      // 可选：是否保留已完成的任务记录？目前逻辑是删除
      this.db.removePendingTask(taskId);
    } catch (error) {
      console.error('[WorkerEngine] Task failed:', taskId, error);
      this.db.updatePendingTaskStatus(taskId, 'failed');
      // 失败的任务保留在数据库中，供人工检查或重试
      // this.db.removePendingTask(taskId);
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
          console.warn('[WorkerEngine] Task timeout:', taskId);
          this.handleTimeout(taskId, task);
        }
      }
    }, this.options.heartbeatIntervalMs);
  }

  private handleTimeout(taskId: string, task: QueueTask) {
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
