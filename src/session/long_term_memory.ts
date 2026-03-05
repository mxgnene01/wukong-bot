import { getDB } from '../db';
import { getAgent } from '../agent';
import { logger } from '../utils/logger';
import type {
  LongTermMemory,
  MemoryFact,
  UserContext,
  HistoryContext,
  PendingMemoryUpdate,
  MemoryExtractionResult,
  HistoryMessage,
  MemorySystemConfig,
} from '../types';

// 默认配置
const DEFAULT_CONFIG: MemorySystemConfig = {
  enabled: true,
  debounceSeconds: 30,
  maxFacts: 100,
  factConfidenceThreshold: 0.7,
  injectionEnabled: true,
  maxInjectionChars: 3000,
};

// 记忆提取提示词
const MEMORY_EXTRACTION_PROMPT = `你是一个记忆提取专家。请分析对话历史，提取关于用户的关键信息。

请以 JSON 格式返回结果，格式如下：
\`\`\`json
{
  "userContext": {
    "work": "用户的工作相关信息（职业、公司、项目等）",
    "personal": "用户的个人信息（喜好、习惯等）",
    "currentFocus": "用户当前关注的事情"
  },
  "userProfile": {
    "name": "用户的名字（如果提到）",
    "role": "用户的职位/角色",
    "techStack": ["提到的技术栈"],
    "communicationStyle": "用户的沟通偏好/风格",
    "projects": ["提到的项目名"]
  },
  "newFacts": [
    {
      "content": "具体的事实内容",
      "confidence": 0.9
    }
  ]
}
\`\`\`

规则：
1. 所有字段都是可选的，如果没有相关信息可以不包含
2. confidence 是 0-1 之间的数字，表示你对这个事实的确定程度
3. 只提取明确提到的信息，不要猜测
4. 事实要具体、简洁
5. userProfile 里只填写对话中明确出现的信息
6. 如果没有新信息，返回空的 {}

只返回 JSON，不要包含其他文字。`;

export class LongTermMemoryManager {
  private db = getDB();
  private config: MemorySystemConfig;
  private pendingUpdates: Map<string, PendingMemoryUpdate> = new Map();
  private debounceTimers: Map<string, any> = new Map();
  private agent = getAgent();

  // 开启自动 LLM 提取（带防抖和累积阈值保护）
  private autoExtractionEnabled = true;
  // 至少累积多少条消息才触发一次 LLM 提取
  private extractionThreshold = 4;

  constructor(config: Partial<MemorySystemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 获取用户的长期记忆
   */
  getMemory(userId: string): LongTermMemory {
    const key = `memory:${userId}`;
    const stored = this.db.getSetting(key);

    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        logger.warn('[LongTermMemory] Failed to parse stored memory, creating new one');
      }
    }

    return this.createEmptyMemory(userId);
  }

  /**
   * 保存用户的长期记忆
   */
  saveMemory(userId: string, memory: LongTermMemory): void {
    const key = `memory:${userId}`;
    memory.updatedAt = Date.now();
    this.db.setSetting(key, JSON.stringify(memory));
    logger.debug(`[LongTermMemory] Saved memory for user ${userId}, ${memory.facts.length} facts`);
  }

  /**
   * 创建空的记忆结构
   */
  private createEmptyMemory(userId: string): LongTermMemory {
    return {
      version: '1.0',
      userId,
      userContext: {},
      history: {},
      facts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 添加消息到待处理队列（带防抖）
   * 
   * [P6 Fix] 对自我介绍类消息立即触发 LTM 提取，不等 batch
   */
  queueMessage(userId: string, message: HistoryMessage): void {
    if (!this.config.enabled) return;

    if (!this.autoExtractionEnabled) {
      return;
    }

    // [P6 Fix] 检测自我介绍类消息 — 包含关键个人信息，立即触发提取
    if (message.role === 'user' && this.isPersonalInfoMessage(message.content)) {
      logger.info(`[LongTermMemory] Detected personal info message from ${userId}, triggering immediate extraction`);
      // 将当前消息直接处理，不走防抖
      this.processImmediateExtraction(userId, message).catch(e => {
        logger.error('[LongTermMemory] Immediate extraction failed:', e);
      });
      return;
    }

    const existing = this.pendingUpdates.get(userId);
    if (existing) {
      existing.messages.push(message);
      // 累积阈值：消息数不够时，只累积不触发
      if (existing.messages.length < this.extractionThreshold) {
        return;
      }
    } else {
      this.pendingUpdates.set(userId, {
        userId,
        messages: [message],
        addedAt: Date.now(),
      });
      // 首条消息，还没到阈值，直接返回
      return;
    }

    // 清除之前的定时器
    const existingTimer = this.debounceTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 设置新的防抖定时器
    const timer = setTimeout(() => {
      this.processPendingUpdate(userId);
    }, this.config.debounceSeconds * 1000);

    this.debounceTimers.set(userId, timer);
  }

  /**
   * [P6] 检测是否包含个人关键信息（姓名/职位/部门/家庭等）
   */
  private isPersonalInfoMessage(content: string): boolean {
    const text = content.toLowerCase();
    const personalSignals = [
      '我叫', '我是', '名字是', '我的名字',
      '任职', '职位是', '在职', '负责',
      '来自', '部门', '团队',
    ];
    // 至少命中 1 个关键词，且内容长度合理（排除极短的 "我是" 类片段）
    return content.length > 10 && personalSignals.some(sig => text.includes(sig));
  }

  /**
   * [P6] 立即提取记忆（不经过防抖，用于自我介绍类消息）
   */
  private async processImmediateExtraction(userId: string, message: HistoryMessage): Promise<void> {
    try {
      const extraction = await this.extractMemoryFromMessages([message]);
      if (!extraction) return;

      const memory = this.getMemory(userId);
      this.applyExtraction(memory, extraction);
      this.saveMemory(userId, memory);

      // 同步写入 UserProfileManager
      try {
        const { getUserProfileManager } = await import('../workspace/user');
        const upm = getUserProfileManager();
        const updates: Record<string, any> = {};

        const ctx = extraction.userContext;
        if (ctx) {
          if (ctx.work) updates.role = ctx.work;
          if (ctx.currentFocus) updates.projects = [ctx.currentFocus];
        }

        const profile = (extraction as any).userProfile;
        if (profile) {
          if (profile.name) updates.name = profile.name;
          if (profile.role) updates.role = profile.role;
          if (profile.techStack?.length) updates.techStack = profile.techStack;
          if (profile.communicationStyle) updates.communicationStyle = profile.communicationStyle;
          if (profile.projects?.length) updates.projects = [...(updates.projects || []), ...profile.projects];
        }

        if (Object.keys(updates).length > 0) {
          upm.learnFromConversation(userId, updates);
          logger.info(`[LongTermMemory] Immediate UserProfile updated for ${userId}: ${Object.keys(updates).join(', ')}`);
        }
      } catch (e) {
        logger.debug('[LongTermMemory] Immediate UserProfile sync skipped:', e);
      }
    } catch (e) {
      logger.error('[LongTermMemory] Immediate extraction failed:', e);
    }
  }

  /**
   * 处理待更新的记忆
   */
  private async processPendingUpdate(userId: string): Promise<void> {
    const pending = this.pendingUpdates.get(userId);
    if (!pending) return;

    this.pendingUpdates.delete(userId);
    this.debounceTimers.delete(userId);

    logger.info(`[LongTermMemory] Processing memory update for user ${userId}, ${pending.messages.length} messages`);

    try {
      // 用 LLM 提取记忆
      const extraction = await this.extractMemoryFromMessages(pending.messages);
      if (!extraction) return;

      // 更新记忆
      const memory = this.getMemory(userId);
      this.applyExtraction(memory, extraction);
      this.saveMemory(userId, memory);

      // === 同步写入 UserProfileManager（自动学习触发点） ===
      try {
        const { getUserProfileManager } = await import('../workspace/user');
        const upm = getUserProfileManager();
        const updates: Record<string, any> = {};

        // 从 userContext 提取
        const ctx = extraction.userContext;
        if (ctx) {
          if (ctx.work) updates.role = ctx.work;
          if (ctx.currentFocus) updates.projects = [ctx.currentFocus];
        }

        // 从 userProfile 直接映射（LLM 新格式输出）
        const profile = (extraction as any).userProfile;
        if (profile) {
          if (profile.name) updates.name = profile.name;
          if (profile.role) updates.role = profile.role;
          if (profile.techStack?.length) updates.techStack = profile.techStack;
          if (profile.communicationStyle) updates.communicationStyle = profile.communicationStyle;
          if (profile.projects?.length) updates.projects = [...(updates.projects || []), ...profile.projects];
        }

        if (Object.keys(updates).length > 0) {
          upm.learnFromConversation(userId, updates);
          logger.info(`[LongTermMemory] UserProfile updated for ${userId}: ${Object.keys(updates).join(', ')}`);
        }
      } catch (e) {
        logger.debug('[LongTermMemory] UserProfile sync skipped:', e);
      }

      // === 同步写入 DailyLog ===
      try {
        const { getDailyLogManager } = await import('../workspace/daily-log');
        const dlm = getDailyLogManager();
        const factsSummary = (extraction.newFacts || []).map(f => f.content).join('; ');
        if (factsSummary) {
          dlm.logLearning(`从对话中提取: ${factsSummary}`, userId);
        }
      } catch (e) {
        logger.debug('[LongTermMemory] DailyLog sync skipped:', e);
      }
    } catch (e) {
      logger.error('[LongTermMemory] Failed to process memory update:', e);
    }
  }

  /**
   * 用 LLM 从对话中提取记忆
   */
  private async extractMemoryFromMessages(messages: HistoryMessage[]): Promise<MemoryExtractionResult | null> {
    if (messages.length === 0) return null;

    // 格式化对话
    const conversationText = messages
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n\n');

    const prompt = `对话历史：\n\n${conversationText}\n\n请提取记忆。`;

    const result = await this.agent.execute(prompt, {
      systemPrompt: MEMORY_EXTRACTION_PROMPT,
      isInternalCall: true, // 跳过 SAFETY_PROMPT
      skipPermissions: true,
    });

    if (!result.success) {
      logger.warn('[LongTermMemory] Memory extraction failed:', result.error);
      return null;
    }

    // 从输出中提取 JSON
    const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      // 尝试直接解析
      try {
        return JSON.parse(result.output);
      } catch {
        return null;
      }
    }

    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      logger.warn('[LongTermMemory] Failed to parse extraction result:', e);
      return null;
    }
  }

  /**
   * 应用提取结果到记忆
   */
  private applyExtraction(memory: LongTermMemory, extraction: MemoryExtractionResult): void {
    // 更新 userContext
    if (extraction.userContext) {
      memory.userContext = {
        ...memory.userContext,
        ...extraction.userContext,
      };
    }

    // 添加新事实
    if (extraction.newFacts) {
      for (const fact of extraction.newFacts) {
        // 过滤低置信度的事实
        if (fact.confidence < this.config.factConfidenceThreshold) {
          continue;
        }

        // 检查是否已存在相似的事实
        const exists = memory.facts.some(
          f => f.content.toLowerCase() === fact.content.toLowerCase()
        );
        if (exists) continue;

        // 添加新事实
        memory.facts.push({
          id: crypto.randomUUID(),
          content: fact.content,
          confidence: fact.confidence,
          source: 'conversation',
          timestamp: Date.now(),
        });
      }
    }

    // 限制事实数量
    if (memory.facts.length > this.config.maxFacts) {
      // 按置信度和时间排序，保留最新/最确定的
      memory.facts.sort((a, b) => {
        const scoreA = a.confidence * 0.7 + (a.timestamp / Date.now()) * 0.3;
        const scoreB = b.confidence * 0.7 + (b.timestamp / Date.now()) * 0.3;
        return scoreB - scoreA;
      });
      memory.facts = memory.facts.slice(0, this.config.maxFacts);
    }
  }

  /**
   * 格式化为注入 system prompt 的字符串
   */
  formatForInjection(memory: LongTermMemory): string | null {
    if (!this.config.injectionEnabled) return null;
    if (memory.facts.length === 0 && Object.keys(memory.userContext).length === 0) {
      return null;
    }

    const parts: string[] = [];

    // 用户上下文
    if (Object.keys(memory.userContext).length > 0) {
      const ctx = memory.userContext;
      const ctxParts: string[] = [];
      if (ctx.work) ctxParts.push(`工作: ${ctx.work}`);
      if (ctx.personal) ctxParts.push(`个人: ${ctx.personal}`);
      if (ctx.currentFocus) ctxParts.push(`当前关注: ${ctx.currentFocus}`);
      if (ctxParts.length > 0) {
        parts.push(`关于用户:\n${ctxParts.join('\n')}`);
      }
    }

    // 事实列表
    if (memory.facts.length > 0) {
      const factsText = memory.facts
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .map(f => `- ${f.content}`)
        .join('\n');
      parts.push(`已知事实:\n${factsText}`);
    }

    const result = parts.join('\n\n');

    // 检查字符数限制
    if (result.length > this.config.maxInjectionChars) {
      return result.slice(0, this.config.maxInjectionChars) + '...';
    }

    return result;
  }

  /**
   * 手动添加/更新用户上下文（用于明确设定）
   */
  updateUserContext(userId: string, context: Partial<UserContext>): void {
    const memory = this.getMemory(userId);
    memory.userContext = { ...memory.userContext, ...context };
    this.saveMemory(userId, memory);
  }

  /**
   * 手动添加事实（用于明确设定）
   */
  addFact(userId: string, content: string, confidence: number = 1.0): void {
    const memory = this.getMemory(userId);

    // 检查是否已存在
    const exists = memory.facts.some(
      f => f.content.toLowerCase() === content.toLowerCase()
    );
    if (exists) return;

    memory.facts.push({
      id: crypto.randomUUID(),
      content,
      confidence,
      source: 'explicit',
      timestamp: Date.now(),
    });

    this.saveMemory(userId, memory);
  }

  /**
   * 清除用户的所有记忆
   */
  clearMemory(userId: string): void {
    const key = `memory:${userId}`;
    // 直接保存一个空的
    this.saveMemory(userId, this.createEmptyMemory(userId));
    logger.info(`[LongTermMemory] Cleared memory for user ${userId}`);
  }
}

// 单例
let longTermMemoryInstance: LongTermMemoryManager | null = null;

export function getLongTermMemoryManager(): LongTermMemoryManager {
  if (!longTermMemoryInstance) {
    longTermMemoryInstance = new LongTermMemoryManager();
  }
  return longTermMemoryInstance;
}
