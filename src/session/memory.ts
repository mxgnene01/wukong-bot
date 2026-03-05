import type { MemoryConfig, Session } from '../types';
import { getDB } from '../db';
import { getLongTermMemoryManager } from './long_term_memory';
import { getUserProfileManager } from '../workspace/user';
import { getDailyLogManager } from '../workspace/daily-log';
import { logger } from '../utils/logger';

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

    // 优先使用 UserProfileManager（文件系统），回退到 DB 老方式
    let userProfile: string;
    try {
      const upm = getUserProfileManager();
      userProfile = upm.formatForSystemPrompt(session.userId);
    } catch (e) {
      logger.debug(`[Memory] UserProfileManager fallback to DB:`, e);
      userProfile = this.getUserProfile(session.userId);
    }

    // Soul 系统注入
    let soulPrompt: string | undefined;
    try {
      const { getSoulManager } = require('../soul');
      const soulMgr = getSoulManager();
      const soul = soulMgr.getSoul('default');
      soulPrompt = soulMgr.formatForSystemPrompt(soul);
    } catch (e) {
      // Soul 系统可选，不阻塞
    }

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
      soulPrompt,
      memoryInjection,
      recentHistory,
    });
  }

  private getRecentHistory(session: Session, maxMessages: number): string | undefined {
    const history = session.history || [];
    if (history.length === 0) return undefined;

    // 过滤掉低质量的历史消息（错误回复、空内容等）
    const filtered = history.filter(msg => {
      if (!msg.content || msg.content.trim().length === 0) return false;
      // 过滤掉错误消息和无意义的系统回复
      if (msg.role === 'assistant') {
        const content = msg.content.trim();
        if (content.startsWith('Unknown skill:')) return false;
        if (content.startsWith('❌')) return false;
        if (content.length < 5) return false;
      }
      return true;
    });

    if (filtered.length === 0) return undefined;

    // 取最近的 maxMessages 条（过滤后）
    const recent = filtered.slice(-maxMessages);

    const parts = recent.map(msg => {
      const role = msg.role === 'user' ? '用户' : '助手';
      // 截断过长的消息，避免 system prompt 膨胀
      let content = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
      // 移除结构化指令，避免历史中的指令成为 few-shot 范例被模仿
      content = content.replace(/\[SCHEDULE_TASK[^\]]*\][\s\S]*?\[\/SCHEDULE_TASK\]/g, '[已设置定时提醒]');
      content = content.replace(/\[AGENT_SEND[^\]]*\][\s\S]*?\[\/AGENT_SEND\]/g, '[已发送Agent消息]');
      content = content.replace(/\[TASK_DONE[^\]]*\][\s\S]*?\[\/TASK_DONE\]/g, '[任务完成]');
      content = content.replace(/\[UPDATE_SOUL[^\]]*\][\s\S]*?\[\/UPDATE_SOUL\]/g, '[已更新Soul]');
      return `${role}: ${content}`;
    });

    return parts.join('\n\n');
  }

  private combineMemory(config: MemoryConfig & { soulPrompt?: string, memoryInjection?: string, recentHistory?: string }): string {
    let prompt = '';

    if (config.soulPrompt) {
      prompt += `===== Soul (人格与哲学) =====\n${config.soulPrompt}\n\n`;
    }

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
    // 写入 Daily Log
    try {
      const dlm = getDailyLogManager();
      dlm.logConversation(userId || 'unknown', sessionId, `[用户] ${content.slice(0, 200)}`);
    } catch (e) {
      logger.debug('[Memory] DailyLog write skipped:', e);
    }
  }

  saveAssistantMessage(sessionId: string, content: string, userId?: string) {
    this.db.appendHistory(sessionId, { role: 'assistant', content });
    // 同时加入长期记忆队列
    if (userId) {
      this.longTermMemory.queueMessage(userId, { role: 'assistant', content });
    }
    // 写入 Daily Log
    try {
      const dlm = getDailyLogManager();
      dlm.logConversation(userId || 'unknown', sessionId, `[助手] ${content.slice(0, 200)}`);
    } catch (e) {
      logger.debug('[Memory] DailyLog write skipped:', e);
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
