import type { MemoryConfig, Session } from '../types';
import { getDB } from '../db';
import { getLongTermMemoryManager } from './long_term_memory';

const DEFAULT_AGENT_IDENTITY = `你是 Wukong Bot
你的职责是：
1. 帮助用户编写、审查和重构代码
2. 回答用户的个人、技术问题
请保持专业、友好和高效的沟通风格。`;

const DEFAULT_USER_PROFILE = `用户是一名测试经理，喜欢简洁明了的回复。`;

export class MemoryManager {
  private db = getDB();
  private longTermMemory = getLongTermMemoryManager();

  buildSystemPrompt(session: Session): string {
    const agentIdentity = this.getAgentIdentity(session.userId);
    const userProfile = this.getUserProfile(session.userId);

    // 获取长期记忆
    const longTermMemory = this.longTermMemory.getMemory(session.userId);
    const memoryInjection = this.longTermMemory.formatForInjection(longTermMemory) ?? undefined;

    // 只有当 Claude Session ID 不存在时（会话失效），才注入最近对话历史
    // 如果有有效的 claudeSessionId，Claude Code CLI 会自己维护对话历史
    let recentHistory: string | undefined;
    if (!session.claudeSessionId) {
      recentHistory = this.getRecentHistory(session, 6);
    }

    return this.combineMemory({
      agentIdentity,
      userProfile,
      memoryInjection,
      recentHistory,
    });
  }

  private getRecentHistory(session: Session, maxMessages: number): string | undefined {
    const history = session.history || [];
    if (history.length === 0) return undefined;

    // 取最近的 maxMessages 条
    const recent = history.slice(-maxMessages);

    const parts = recent.map(msg => {
      const role = msg.role === 'user' ? '用户' : '助手';
      return `${role}: ${msg.content}`;
    });

    return parts.join('\n\n');
  }

  private combineMemory(config: MemoryConfig & { memoryInjection?: string, recentHistory?: string }): string {
    let prompt = '';

    if (config.agentIdentity) {
      prompt += `===== 角色身份 =====\n${config.agentIdentity}\n\n`;
    }

    if (config.userProfile) {
      prompt += `===== 用户画像 =====\n${config.userProfile}\n\n`;
    }

    if (config.memoryInjection) {
      prompt += `===== 关于用户的记忆 =====\n${config.memoryInjection}\n\n`;
    }

    if (config.recentHistory) {
      prompt += `===== 最近对话 =====\n${config.recentHistory}\n\n`;
    }

    return prompt;
  }

  getAgentIdentity(userId: string): string {
    const key = `agent_identity:${userId}`;
    return this.db.getSetting(key) || DEFAULT_AGENT_IDENTITY;
  }

  setAgentIdentity(userId: string, identity: string) {
    const key = `agent_identity:${userId}`;
    this.db.setSetting(key, identity);
  }

  getUserProfile(userId: string): string {
    const key = `user_profile:${userId}`;
    return this.db.getSetting(key) || DEFAULT_USER_PROFILE;
  }

  setUserProfile(userId: string, profile: string) {
    const key = `user_profile:${userId}`;
    this.db.setSetting(key, profile);
  }

  saveUserMessage(sessionId: string, content: string, userId?: string) {
    this.db.appendHistory(sessionId, { role: 'user', content });
    // 同时加入长期记忆队列
    if (userId) {
      this.longTermMemory.queueMessage(userId, { role: 'user', content });
    }
  }

  saveAssistantMessage(sessionId: string, content: string, userId?: string) {
    this.db.appendHistory(sessionId, { role: 'assistant', content });
    // 同时加入长期记忆队列
    if (userId) {
      this.longTermMemory.queueMessage(userId, { role: 'assistant', content });
    }
  }
}

let memoryManagerInstance: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager();
  }
  return memoryManagerInstance;
}
