// 参考 deer-flow 的 Executor 设计

import { getConfig } from '../config';
import { getDB } from '../db';
import { getAgent } from '../agent';
import { getSessionManager } from '../session';
import { getMemoryManager } from '../session/memory';
import { getSessionRecorder } from '../session/recorder';
import { getSkillRegistry, type Skill } from '../skills';
import { sendCard, updateCard, sendMessageSmart, shouldUseCard } from '../lark/client';
import { addTypingIndicator, removeTypingIndicator, startKeepalive, stopKeepalive, type TypingIndicatorState } from '../lark/typing';
import { buildProgressCard, buildResultCard, buildErrorCard } from '../cards';
import { logger } from '../utils/logger';
import type { QueueTask, TaskStatus } from '../types';

export interface TaskExecutorOptions {
  onProgress?: (taskId: string, status: TaskStatus, message: string, percentage?: number) => Promise<void>;
  onComplete?: (taskId: string, success: boolean, output: string, duration: number) => Promise<void>;
  onError?: (taskId: string, error: string) => Promise<void>;
}

export class TaskExecutor {
  private config = getConfig();
  private db = getDB();
  private agent = getAgent();
  private sessionManager = getSessionManager();
  private memoryManager = getMemoryManager();
  private skillRegistry = getSkillRegistry();
  private options: TaskExecutorOptions;

  constructor(options: TaskExecutorOptions = {}) {
    this.options = options;
  }

  async execute(task: QueueTask): Promise<void> {
    const startTime = Date.now();
    const taskId = task.id;
    let typingState: TypingIndicatorState | null = null;

    logger.log('[Executor] Starting task:', taskId);

    try {
      // 在用户消息上添加"敲键盘"表情，表示正在处理
      if (task.context.messageId) {
        typingState = await addTypingIndicator(task.context.messageId);
        logger.log('[Executor] Added typing indicator, reactionId:', typingState.reactionId);
        // 启动 keepalive，确保长时间处理时表情不会消失
        typingState = startKeepalive(typingState);
      }

      await this.updateProgress(taskId, 'processing', '正在初始化...', 5);

      // 获取或创建会话
      const session = this.sessionManager.getOrCreateSession(task.context);
      logger.log('[Executor] Current session - sessionId:', session.sessionId, 'claudeSessionId:', session.claudeSessionId);

      // 获取会话记录器
      const recorder = getSessionRecorder(session.sessionId);
      recorder.startSession();

      await this.updateProgress(taskId, 'processing', '正在加载技能...', 15);

      // 获取匹配的技能
      logger.log('[Executor] Matching skills for content:', task.content);
      const skills = this.getMatchedSkills(taskId, task.content);
      logger.log('[Executor] Matched skills:', skills.map(s => s.name));
      const skillPrompt = this.buildSkillPrompt(skills);
      if (skillPrompt) {
        logger.log('[Executor] Skill prompt added');
      }

      await this.updateProgress(taskId, 'processing', '正在构建系统提示...', 25);

      // 构建系统提示
      const systemPrompt = this.memoryManager.buildSystemPrompt(session);
      const fullSystemPrompt = [skillPrompt, systemPrompt].filter(Boolean).join('\n\n');

      // 保存当前用户消息到历史记录（同时加入长期记忆队列）
      this.memoryManager.saveUserMessage(session.sessionId, task.content, session.userId);

      // 记录用户消息到会话记录
      recorder.recordUserMessage(task.content, {
        messageId: task.context.messageId,
        timestamp: Date.now(),
      });

      await this.updateProgress(taskId, 'processing', '正在调用 Claude Code CLI...', 40);

      // 执行 Agent
      let result = await this.agent.execute(task.content, {
        systemPrompt: fullSystemPrompt,
        timeout: this.config.claude.timeout,
        resumeSessionId: session.claudeSessionId,
        skipPermissions: true,
      });

      // 简单重试：如果是 "No conversation found" 错误，清除 sessionId 后重试一次
      if (!result.success && result.error && result.error.includes('No conversation found')) {
        logger.info(`[Executor] Session ${session.claudeSessionId} not found. Clearing invalid session ID and retrying with new session...`);
        session.claudeSessionId = undefined;
        this.sessionManager.saveSession(session);

        // 重试（不传 resumeSessionId，开启新会话）
        result = await this.agent.execute(task.content, {
          systemPrompt: fullSystemPrompt,
          timeout: this.config.claude.timeout,
          resumeSessionId: session.claudeSessionId,
          skipPermissions: true,
        });
      }

      // 更新 Claude Session ID
      if (result.sessionId && result.sessionId !== session.claudeSessionId) {
        logger.info(`[Executor] New Claude Session ID: ${result.sessionId}`);
        session.claudeSessionId = result.sessionId;
        this.sessionManager.saveSession(session);
      }

      // 记录 token usage 数据
      if (result.tokenUsage) {
        logger.info('[Executor] Token usage:', result.tokenUsage);
      }

      if (result.success) {
        // 保存助手消息（同时加入长期记忆队列）
        this.memoryManager.saveAssistantMessage(session.sessionId, result.output, session.userId);
      }

      // 记录助手消息到会话记录
      recorder.recordAssistantMessage(result.output, {
        tokenUsage: result.tokenUsage,
        stopReason: result.success ? 'stop' : 'error',
        timestamp: Date.now(),
      });

      const duration = Date.now() - startTime;

      // 任务完成后，发送结果
      await this.sendResult(task, result.success, result.output, result.error, duration, taskId);

      // 注意：数据库状态更新已移至 WorkerEngine 层处理
      // 这里只需要负责业务逻辑

      if (this.options.onComplete) {
        await this.options.onComplete(taskId, result.success, result.output, duration);
      }

      logger.log('[Executor] Task completed:', taskId, 'duration:', duration, 'ms');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Executor] Task failed:', taskId, error);

      await this.sendError(task, errorMessage, taskId);

      if (this.options.onError) {
        await this.options.onError(taskId, errorMessage);
      }

      throw error;
    } finally {
      // 无论成功或失败，都移除"敲键盘"表情
      if (typingState) {
        try {
          await removeTypingIndicator(typingState);
          logger.log('[Executor] Removed typing indicator');
        } catch (e) {
          logger.warn('[Executor] Failed to remove typing indicator:', e);
        }
      }
    }
  }

  private getMatchedSkills(taskId: string, content?: string): Skill[] {
    const skills: Skill[] = [];
    const skillIds = new Set<string>();

    // 1. 从数据库获取预设技能
    const skillIdsJson = this.db.getSetting(`skills:${taskId}`);
    if (skillIdsJson) {
      try {
        const ids: string[] = JSON.parse(skillIdsJson);
        for (const id of ids) {
          const skill = this.skillRegistry.get(id);
          if (skill) {
            skills.push(skill);
            skillIds.add(skill.id);
          }
        }
      } catch (e) {
        logger.warn('[Executor] Failed to parse skill IDs:', e);
      }
    }

    // 2. 根据内容动态匹配技能
    if (content) {
      const matches = this.skillRegistry.match(content);
      logger.log('[Executor] Skill matches found:', matches.length);
      for (const match of matches) {
        if (!skillIds.has(match.skill.id)) {
          skills.push(match.skill);
          skillIds.add(match.skill.id);
          logger.log(`[Executor] Auto-matched skill: ${match.skill.name} (${match.confidence.toFixed(2)})`);
        }
      }
    }

    return skills;
  }

  private buildSkillPrompt(skills: Skill[]): string {
    if (skills.length === 0) return '';

    const parts = skills.map(skill => {
      return `===== 技能: ${skill.name} =====\n${skill.systemPrompt}`;
    });

    return parts.join('\n\n');
  }

  private async updateProgress(
    taskId: string,
    status: TaskStatus,
    message: string,
    percentage?: number
  ) {
    this.db.heartbeat(taskId);

    if (this.options.onProgress) {
      await this.options.onProgress(taskId, status, message, percentage);
    }

    const cardMessageId = this.db.getSetting(`card:${taskId}`);
    if (cardMessageId) {
      try {
        await updateCard(cardMessageId, buildProgressCard(status, message, percentage, taskId));
      } catch (e) {
        logger.error('Failed to update card:', e);
      }
    }
  }

  private async sendResult(
    task: QueueTask,
    success: boolean,
    output: string,
    error: string | undefined,
    duration: number,
    taskId: string
  ) {
    const cardMessageId = this.db.getSetting(`card:${taskId}`);
    const resultContent = success ? output : (error || output);

    if (cardMessageId) {
      // 如果已有排队状态卡片，总是更新它
      await updateCard(
        cardMessageId,
        buildResultCard(success, resultContent, duration, taskId)
      );
    } else {
      // 没有卡片时才智能选择发送模式
      await sendMessageSmart(
        task.context,
        resultContent,
        success,
        duration,
        taskId,
        task.context.messageId
      );
    }
  }

  private async sendError(task: QueueTask, error: string, taskId: string) {
    const cardMessageId = this.db.getSetting(`card:${taskId}`);

    if (cardMessageId) {
      await updateCard(cardMessageId, buildErrorCard(error, taskId));
    } else {
      await sendCard(task.context, buildErrorCard(error, taskId));
    }
  }
}
