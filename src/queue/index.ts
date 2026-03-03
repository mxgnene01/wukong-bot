import type { QueueTask, ChatContext, MessageAttachment } from '../types';
import { config } from '../utils/config';
import { getDB } from '../db';

interface QueueHandler {
  (task: QueueTask): Promise<void>;
}

class TaskQueue {
  private tasks: Map<string, QueueTask> = new Map();
  private handlers: QueueHandler[] = [];
  private processing: Set<string> = new Set();
  private subscribers: Set<(task: QueueTask) => void> = new Set();
  private db = getDB();

  enqueue(type: 'message' | 'scheduled', context: ChatContext, content: string, attachments?: MessageAttachment[], scheduledTaskId?: string): string {
    return this.enqueueTask({
      type,
      context,
      content,
      attachments,
      scheduledTaskId
    });
  }

  enqueueTask(params: {
    type: 'message' | 'scheduled';
    context: ChatContext;
    content: string;
    attachments?: MessageAttachment[];
    scheduledTaskId?: string;
    sessionKey?: string;
    agentId?: string;
    skillId?: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const taskId = crypto.randomUUID();
    const task: QueueTask = {
      id: taskId,
      type: params.type,
      context: params.context,
      content: params.content,
      attachments: params.attachments,
      retryCount: 0,
      maxRetries: config.maxRetries,
      createdAt: Date.now(),
      scheduledTaskId: params.scheduledTaskId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      skillId: params.skillId,
      correlationId: params.correlationId,
      metadata: params.metadata,
    };

    // 1. 持久化到数据库
    this.db.createPendingTask(taskId, task, 'pending');

    // 2. 写入内存队列
    this.tasks.set(taskId, task);
    this.notifySubscribers(task);
    this.processNext();

    return taskId;
  }

  // 从数据库恢复任务到内存队列
  recover(task: QueueTask) {
    if (!this.tasks.has(task.id) && !this.processing.has(task.id)) {
      this.tasks.set(task.id, task);
      this.processNext();
    }
  }

  subscribe(handler: (task: QueueTask) => void) {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  private notifySubscribers(task: QueueTask) {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(task);
      } catch (e) {
        console.error('Queue subscriber error:', e);
      }
    }
  }

  registerHandler(handler: QueueHandler) {
    this.handlers.push(handler);
  }

  private async processNext() {
    // 遍历所有待处理任务
    for (const [taskId, task] of this.tasks) {
      // 如果该任务已经在处理中，跳过
      if (this.processing.has(taskId)) continue;

      this.processing.add(taskId);
      this.tasks.delete(taskId);

      // 并发执行任务，不等待结果
      this.runTask(taskId, task);
    }
  }

  private async runTask(taskId: string, task: QueueTask) {
    try {
      // 3. 更新数据库状态为处理中
      this.db.updatePendingTaskStatus(taskId, 'processing');
      
      await this.processTask(task);
      
      // 4. 任务完成，从 pending_tasks 表中移除（或标记为 completed，取决于清理策略）
      // 这里我们选择移除，因为 completed 状态可能只在历史记录里保留
      // 或者如果需要在 db 中保留 completed 记录，请调用 updatePendingTaskStatus('completed')
      // 目前 WorkerEngine 也会更新状态，这里主要负责队列层面的逻辑
    } catch (e) {
      console.error(`Unexpected error processing task ${taskId}:`, e);
      // 失败状态更新由 WorkerEngine 或 processTask 内部处理
    } finally {
      this.processing.delete(taskId);
      this.processNext();
    }
  }

  private async processTask(task: QueueTask) {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      try {
        task.retryCount = attempt;

        for (const handler of this.handlers) {
          await handler(task);
        }

        return;
      } catch (error) {
        lastError = error as Error;
        console.error(`Task ${task.id} attempt ${attempt + 1} failed:`, error);

        if (attempt < task.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    console.error(`Task ${task.id} failed after ${task.maxRetries + 1} attempts:`, lastError);
    throw lastError; // 抛出错误以便上层捕获
  }

  getQueueSize(): number {
    return this.tasks.size + this.processing.size;
  }

  getPendingTaskIds(): string[] {
    return [...this.tasks.keys()];
  }
}

let queueInstance: TaskQueue | null = null;

export function getQueue(): TaskQueue {
  if (!queueInstance) {
    queueInstance = new TaskQueue();
  }
  return queueInstance;
}
