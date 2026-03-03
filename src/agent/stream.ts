import { buildProgressCard } from '../cards';
import { updateCard } from '../lark/client';
import { getDB } from '../db';
import { logger } from '../utils/logger';

export interface StreamChunk {
  type: string;
  content?: string;
  tool?: {
    name: string;
    input: any;
  };
  [key: string]: any;
}

export class StreamProcessor {
  private taskId: string;
  private cardMessageId: string | null = null;
  private buffer = '';
  private lastUpdateTime = 0;
  private updateIntervalMs = 2000;
  private minCharsBeforeUpdate = 500;
  private db = getDB();
  private isComplete = false;
  private lastBufferLength = 0;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.cardMessageId = this.db.getSetting(`card:${taskId}`);
  }

  async processChunk(chunk: StreamChunk) {
    if (this.isComplete) return;

    if (chunk.type === 'content' && chunk.content) {
      this.buffer += chunk.content;
      await this.tryUpdate();
    } else if (chunk.type === 'tool_use') {
      this.buffer += `\n[使用工具: ${chunk.tool?.name}]\n`;
      await this.tryUpdate();
    }
  }

  private async tryUpdate() {
    const now = Date.now();
    const shouldUpdate =
      now - this.lastUpdateTime > this.updateIntervalMs ||
      this.buffer.length - this.lastBufferLength > this.minCharsBeforeUpdate;

    if (shouldUpdate) {
      await this.updateCard();
      this.lastUpdateTime = now;
      this.lastBufferLength = this.buffer.length;
    }
  }

  private async updateCard() {
    if (!this.cardMessageId) return;

    try {
      const displayContent = this.buffer.length > 2000
        ? this.buffer.slice(-2000) + '\n...'
        : this.buffer;

      await updateCard(
        this.cardMessageId,
        buildProgressCard('processing', displayContent, undefined, this.taskId)
      );
    } catch (e) {
      logger.error('[Stream] Failed to update card:', e);
    }
  }

  async complete(finalOutput: string) {
    this.isComplete = true;
    this.buffer = finalOutput;
    await this.updateCard();
  }
}

export function createStreamProcessor(taskId: string) {
  return new StreamProcessor(taskId);
}
