import { getDB } from '../db';
import { updateCard } from '../lark/client';
import { buildProgressCard } from '../cards';
import type { TaskStatus } from '../types';

export class ProgressManager {
  private db = getDB();
  private taskTimers = new Map<string, Timer>();

  async updateProgress(
    taskId: string,
    status: TaskStatus,
    message: string,
    percentage?: number
  ) {
    try {
      this.db.heartbeat(taskId);

      const cardMessageId = this.db.getSetting(`card:${taskId}`);
      if (!cardMessageId) return;

      await updateCard(
        cardMessageId,
        buildProgressCard(status, message, percentage, taskId)
      );
    } catch (error) {
      console.error('Failed to update progress:', error);
    }
  }

  startHeartbeat(taskId: string, intervalMs: number = 30000) {
    this.stopHeartbeat(taskId);

    const timer = setInterval(() => {
      try {
        this.db.heartbeat(taskId);
      } catch (error) {
        console.error('Heartbeat failed:', error);
      }
    }, intervalMs);

    this.taskTimers.set(taskId, timer);
  }

  stopHeartbeat(taskId: string) {
    const timer = this.taskTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.taskTimers.delete(taskId);
    }
  }

  stopAll() {
    for (const timer of this.taskTimers.values()) {
      clearInterval(timer);
    }
    this.taskTimers.clear();
  }

  async setTimeout(taskId: string, timeoutMs: number, onTimeout: () => void) {
    const timer = setTimeout(() => {
      console.log('Task timeout:', taskId);
      onTimeout();
    }, timeoutMs);

    this.taskTimers.set(`timeout:${taskId}`, timer);
  }

  clearTimeout(taskId: string) {
    const timer = this.taskTimers.get(`timeout:${taskId}`);
    if (timer) {
      clearTimeout(timer);
      this.taskTimers.delete(`timeout:${taskId}`);
    }
  }
}

let progressManagerInstance: ProgressManager | null = null;

export function getProgressManager(): ProgressManager {
  if (!progressManagerInstance) {
    progressManagerInstance = new ProgressManager();
  }
  return progressManagerInstance;
}
