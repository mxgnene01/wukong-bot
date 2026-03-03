import type { ChatContext } from '../types';
import { sendCard, updateCard } from '../lark/client';
import { buildProgressCard } from '../cards';

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\brm\s+-r\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
];

export interface Confirmation {
  id: string;
  taskId: string;
  context: ChatContext;
  message: string;
  cardMessageId: string;
  confirmed: boolean;
  createdAt: number;
}

export class ConfirmationManager {
  private pendingConfirmations = new Map<string, Confirmation>();
  private resolveMap = new Map<string, (confirmed: boolean) => void>();

  checkDangerousOperation(output: string): boolean {
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(output));
  }

  async requestConfirmation(
    taskId: string,
    context: ChatContext,
    message: string
  ): Promise<boolean> {
    const confirmationId = crypto.randomUUID();

    const cardMessageId = await sendCard(
      context,
      buildProgressCard('processing', `⚠️ 危险操作确认\n\n${message}\n\n请确认是否继续？`, undefined, taskId)
    );

    return new Promise((resolve) => {
      this.pendingConfirmations.set(confirmationId, {
        id: confirmationId,
        taskId,
        context,
        message,
        cardMessageId,
        confirmed: false,
        createdAt: Date.now(),
      });
      this.resolveMap.set(confirmationId, resolve);
    });
  }

  async confirm(confirmationId: string, confirmed: boolean) {
    const confirmation = this.pendingConfirmations.get(confirmationId);
    if (!confirmation) return;

    confirmation.confirmed = confirmed;
    const resolve = this.resolveMap.get(confirmationId);

    if (resolve) {
      resolve(confirmed);
      this.pendingConfirmations.delete(confirmationId);
      this.resolveMap.delete(confirmationId);
    }
  }

  getPendingConfirmation(taskId: string): Confirmation | undefined {
    for (const conf of this.pendingConfirmations.values()) {
      if (conf.taskId === taskId) {
        return conf;
      }
    }
    return undefined;
  }
}

let managerInstance: ConfirmationManager | null = null;

export function getConfirmationManager(): ConfirmationManager {
  if (!managerInstance) {
    managerInstance = new ConfirmationManager();
  }
  return managerInstance;
}
