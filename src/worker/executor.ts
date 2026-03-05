// 参考 deer-flow 的 Executor 设计

import { getConfig } from '../config';
import { getDB } from '../db';
import { getAgent, SYSTEM_CAPABILITIES_PROMPT } from '../agent';
import { getSessionManager } from '../session';
import { getMemoryManager } from '../session/memory';
import { getSessionRecorder } from '../session/recorder';
import { getSkillRegistry, type Skill } from '../skills';
import { sendCard, updateCard, sendMessageSmart, sendText, shouldUseCard } from '../lark/client';
import { addTypingIndicator, removeTypingIndicator, startKeepalive, stopKeepalive, type TypingIndicatorState } from '../lark/typing';
import { buildProgressCard, buildResultCard, buildErrorCard } from '../cards';
import { logger } from '../utils/logger';
import { getQueue } from '../queue';
import { makeSessionKey, parseSessionKey } from '../agent/session';
import { parseAgentCommands } from '../agent/command-parser';
import { getAgentsManager } from '../workspace/agents';
import { EvolutionEngine } from '../evolution';
import { downloadFile, detectImageType, toBase64 } from '../lark/file';
import type { QueueTask, TaskStatus, AgentMessage } from '../types';

/**
 * 任务复杂度三态：
 * - 'greeting': 纯问候，tryQuickReply 直接返回，不调 CLI
 * - 'chat': 日常闲聊/自我介绍等，调 CLI 但用精简 prompt，跳过 Evaluator
 * - 'complex': 需要完整工具集 + Evaluator 元认知循环
 */
export type TaskComplexity = 'greeting' | 'simple' | 'chat' | 'complex';

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

  async execute(task: QueueTask, options?: TaskExecutorOptions & { signal?: AbortSignal }): Promise<void> {
    const startTime = Date.now();
    const taskId = task.id;
    // 合并配置
    const runOptions = { ...this.options, ...options };
    const signal = options?.signal;

    let typingState: TypingIndicatorState | null = null;
    let currentMessage = '正在初始化...';
    let currentPercentage = 0;
    let progressTimer: NodeJS.Timeout | null = null;

    // === 快速回复路径：纯问候不调 Claude CLI，直接返回 ===
    const quickReply = this.tryQuickReply(task.content);
    if (quickReply) {
      logger.info(`[Executor] Quick reply for greeting: "${task.content}" → "${quickReply}"`);
      const duration = Date.now() - startTime;

      // 保存消息历史
      const session = this.sessionManager.getOrCreateSession(task.context, task.agentId || 'main');
      this.memoryManager.saveUserMessage(session.sessionId, task.content, session.userId);
      this.memoryManager.saveAssistantMessage(session.sessionId, quickReply, session.userId);

      // 直接发送回复
      await this.sendReply(task, quickReply, taskId);
      logger.log(`[Executor] Quick reply completed: ${taskId} duration: ${duration} ms`);
      return;
    }

    // 监听 abort 信号，清理定时器
    if (signal) {
      signal.addEventListener('abort', () => {
        if (progressTimer) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
        logger.warn(`[Executor] Task ${taskId} aborted by signal`);
      });
    }

    const updateProgressWrapper = async (status: TaskStatus, message: string, percentage?: number) => {
      currentMessage = message;
      if (percentage !== undefined) currentPercentage = percentage;
      await this.updateProgress(taskId, status, message, percentage, startTime, runOptions.onProgress);
    };

    // 每 3 秒更新一次进度卡片
    progressTimer = setInterval(() => {
      this.updateProgress(taskId, 'processing', currentMessage, currentPercentage, startTime, runOptions.onProgress).catch(() => {});
    }, 3000);

    logger.log('[Executor] Starting task:', taskId);

    try {
      // 在用户消息上添加"敲键盘"表情，表示正在处理
      if (task.context.messageId) {
        typingState = await addTypingIndicator(task.context.messageId);
        logger.log('[Executor] Added typing indicator, reactionId:', typingState.reactionId);
        // 启动 keepalive，确保长时间处理时表情不会消失
        typingState = startKeepalive(typingState);
      }

      await updateProgressWrapper('processing', '正在初始化...', 5);

      // 确定 Session Key
      const agentId = task.agentId || 'main';
      const sessionKey = task.sessionKey || makeSessionKey(agentId, task.context.userId);

      // 读取收件箱
      const inboxMessages = this.db.readAgentMessages(sessionKey);
      const inboxSection = this.formatInboxForPrompt(inboxMessages);
      
      const agentToolsSection = `
## Agent 通信工具

你可以与其他 Agent 协作。使用以下格式发送消息：

### 发送消息给其他 Agent
\`\`\`
[AGENT_SEND to="agent:<agentId>:<context>" type="<message_type>"]
消息内容
[/AGENT_SEND]
\`\`\`

参数说明：
- to: 目标 Agent 的 session key
- type: 消息类型，可选值：text（普通消息）、task_result（任务结果）、task_request（任务请求）、status_update（状态更新）

### 标记任务完成
当你完成当前任务时，输出：
\`\`\`
[TASK_DONE status="success"]
任务结果摘要（会传递给下一个 Agent 或返回给用户）
[/TASK_DONE]
\`\`\`

如果任务失败：
\`\`\`
[TASK_DONE status="failed" reason="失败原因"]
错误详情
[/TASK_DONE]
\`\`\`
`;

      // 获取或创建会话
      const session = this.sessionManager.getOrCreateSession(task.context, agentId);
      logger.log('[Executor] Current session - sessionId:', session.sessionId, 'claudeSessionId:', session.claudeSessionId);

      // 获取会话记录器
      const recorder = getSessionRecorder(session.sessionId);
      recorder.startSession();

      await updateProgressWrapper('processing', '正在加载技能...', 15);

      // 获取匹配的技能
      logger.log('[Executor] Matching skills for content:', task.content);
      const skills = this.getMatchedSkills(taskId, task.content);
      logger.log('[Executor] Matched skills:', skills.map(s => s.name));
      let skillPrompt = this.buildSkillPrompt(skills);
      if (skillPrompt) {
        logger.log('[Executor] Skill prompt added');
      }

      // ──── 技能进化：预注入技能列表 ────
      // 当匹配到 meta_learning 技能时，将当前已安装技能列表注入 prompt，
      // 由 LLM 自主判断用户意图（查询 / 学习 / 混合），不再做硬编码意图分类。
      const hasEvolutionSkill = skills.some(s => s.id === 'meta_learning');
      if (hasEvolutionSkill) {
        try {
          const evolution = new EvolutionEngine();
          const skillList = evolution.listSkills();
          skillPrompt = (skillPrompt || '') + '\n\n## 当前已安装技能列表\n' + skillList;
          logger.info('[Executor] Evolution: injected skill list for LLM-based intent handling');
        } catch (e) {
          logger.error('[Executor] Evolution skill list injection failed:', e);
        }
      }

      await updateProgressWrapper('processing', '正在构建系统提示...', 25);

      // 构建系统提示 — 分层策略：
      // 1. 'greeting'/'simple' 任务：轻量 prompt（只有核心人格）
      // 2. 'chat' 任务：中等 prompt（人格 + 用户画像 + 记忆，不含工具文档）
      // 3. Resume 模式：只注入增量（新匹配技能 + 收件箱）
      // 4. 'complex' 新会话：完整 prompt（人格 + 画像 + 记忆 + 工具文档）
      const taskType = this.getTaskType(task.content);
      const isResume = !!session.claudeSessionId;

      let fullSystemPrompt: string;
      if (taskType === 'greeting' || taskType === 'simple') {
        // 简单任务：只注入核心人格（Soul 的 personality 部分），不带完整画像、记忆和历史
        let lightPrompt: string;
        try {
          const { getSoulManager } = require('../soul');
          const soul = getSoulManager().getSoul('default');
          lightPrompt = soul.personality || '你是 Wukong Bot，保持专业、友好和高效的沟通风格。';
        } catch {
          lightPrompt = '你是 Wukong Bot，保持专业、友好和高效的沟通风格。';
        }
        fullSystemPrompt = lightPrompt;
      } else if (taskType === 'chat') {
        // [P3 Fix] 闲聊任务：注入人格 + 用户画像 + 记忆，但不注入工具文档
        // （SCHEDULE_TASK、AGENT_SEND、UPDATE_SOUL 等对闲聊完全不需要）
        const systemPrompt = this.memoryManager.buildSystemPrompt(session);
        const agentsMgr = getAgentsManager();
        const agentIdentity = agentsMgr.formatForSystemPrompt(agentId);
        fullSystemPrompt = [agentIdentity, skillPrompt, systemPrompt].filter(Boolean).join('\n\n---\n\n');
      } else if (isResume) {
        // Resume 模式：Claude 已有完整 prompt，只注入本轮增量
        const deltaParts: string[] = [];
        // Agent 身份（如果是非 main agent，resume 时也需要提醒身份）
        if (agentId !== 'main') {
          const agentsMgr = getAgentsManager();
          const agentIdentity = agentsMgr.formatForSystemPrompt(agentId);
          if (agentIdentity) deltaParts.push(agentIdentity);
        }
        if (skillPrompt) deltaParts.push(skillPrompt);
        if (inboxSection) deltaParts.push(inboxSection);
        fullSystemPrompt = deltaParts.length > 0 ? deltaParts.join('\n\n---\n\n') : '';
      } else {
        // 新会话 + 复杂任务：完整 prompt
        const systemPrompt = this.memoryManager.buildSystemPrompt(session);
        // 注入 Agent 身份（如果非 main 则加载对应 Agent 定义）
        const agentsMgr = getAgentsManager();
        const agentIdentity = agentsMgr.formatForSystemPrompt(agentId);
        const agentDirectory = agentsMgr.formatAgentDirectory();
        // 系统能力指令（SCHEDULE_TASK、UPDATE_SOUL）仅在复杂任务时注入
        fullSystemPrompt = [agentIdentity, skillPrompt, systemPrompt, SYSTEM_CAPABILITIES_PROMPT, agentToolsSection, agentDirectory, inboxSection].filter(Boolean).join('\n\n---\n\n');
      }

      // 保存当前用户消息到历史记录（同时加入长期记忆队列）
      this.memoryManager.saveUserMessage(session.sessionId, task.content, session.userId);

      // 记录用户消息到会话记录
      recorder.recordUserMessage(task.content, {
        messageId: task.context.messageId,
        timestamp: Date.now(),
      });

      // 处理图片附件：下载并转换为 Base64 传递给 Claude
      let promptContent = task.content;
      
      // 检查是否有图片附件
      if (task.attachments && task.attachments.length > 0) {
        const images = task.attachments.filter(att => att.type === 'image');
        
        if (images.length > 0 && task.context.messageId) {
          await updateProgressWrapper('processing', '正在处理图片...', 30);
          logger.info(`[Executor] Found ${images.length} images, processing...`);
          
          for (const img of images) {
            try {
              // 下载图片
              const buffer = await downloadFile(task.context.messageId, img.fileKey);
              
              // 检测格式
              const type = detectImageType(buffer) || 'jpeg';
              const mimeType = `image/${type}`;
              
              // 转换为 Base64
              const base64Data = buffer.toString('base64');
              
              // 暂时 Claude Code CLI 不支持直接传 image block
              // 我们将图片保存到本地，并告知 CLI 图片位置
              // 或者，如果是走本地代理模式，我们可以尝试将图片嵌入到 Prompt 中（这需要 CLI 支持某种特殊语法）
              
              // 方案：将图片保存到 workspace/images 目录，并提示 CLI 读取
              const imageDir = `${this.config.app.workDir}/images`;
              const imagePath = `${imageDir}/${img.fileKey}.${type}`;
              
              // 确保目录存在
              await Bun.write(imagePath, buffer);
              logger.info(`[Executor] Saved image to ${imagePath}`);
              
              // 追加提示到 Prompt
              promptContent += `\n\n[System Note]\nUser uploaded an image. It has been saved to: ${imagePath}\nPlease read and analyze this image file to understand the user's request.`;
              
            } catch (e) {
              logger.error(`[Executor] Failed to process image ${img.fileKey}:`, e);
              promptContent += `\n\n[System Error] Failed to download/process image: ${img.fileKey}`;
            }
          }
        }
      }

      await updateProgressWrapper('processing', '正在调用 Claude Code CLI...', 40);

      // === 基于时间的进度估算（修复卡片永远卡在 40% 的问题）===
      // CLI 的 stream-json 格式很少产生增量 delta，onProgress 几乎不会被调用
      // 因此我们用独立的定时器按指数曲线推进进度：40% → ~95%
      const cliStartTime = Date.now();
      let lastProgressMessage = '正在思考...';
      const progressEstimator = setInterval(async () => {
        const elapsed = Date.now() - cliStartTime;
        // 指数增长曲线：60 秒到达约 80%，120 秒到达约 90%
        const estimated = Math.min(40 + Math.round(55 * (1 - Math.exp(-elapsed / 60000))), 95);
        const elapsedSec = Math.floor(elapsed / 1000);
        const timeHint = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`;
        await updateProgressWrapper('processing', `${lastProgressMessage}  (${timeHint})`, estimated);
      }, 3000);

      // 执行 Agent
      let result = await this.agent.execute(promptContent, {
        systemPrompt: fullSystemPrompt,
        timeout: this.config.claude.timeout,
        resumeSessionId: session.claudeSessionId,
        skipPermissions: true,
        isSimpleTask: taskType === 'greeting' || taskType === 'simple',
        signal, // 传递中止信号
        onProgress: async (message) => {
             // CLI 流式事件回调（有数据时更新消息文本，进度由 estimator 驱动）
             lastProgressMessage = message;
        }
      });

      // 停止进度估算定时器
      clearInterval(progressEstimator);

      // 解析 Agent 命令
      if (result.success) {
        const commands = parseAgentCommands(result.output);
        for (const cmd of commands) {
          if (cmd.type === 'AGENT_SEND') {
            this.db.sendAgentMessage({
              fromSession: sessionKey,
              toSession: cmd.to!,
              message: cmd.content,
              messageType: cmd.messageType as any || 'text',
              correlationId: cmd.correlationId || task.correlationId,
              metadata: cmd.metadata,
            });

            if (cmd.to) {
              await this.triggerAgentIfNeeded(cmd.to, cmd.content, task);
            }
          } else if (cmd.type === 'TASK_DONE') {
            // 如果是工作流任务，回复给工作流引擎
            if (task.metadata?.workflowId && task.correlationId) {
              const replyTo = `workflow:${task.metadata.runId}`;
              logger.log(`[Executor] Task done, replying to workflow engine: ${replyTo}, correlationId: ${task.correlationId}`);
              
            this.db.sendAgentMessage({
              fromSession: sessionKey,
              toSession: replyTo,
              message: cmd.content,
              messageType: 'task_result',
              correlationId: task.correlationId,
              metadata: {
                status: cmd.status,
                reason: cmd.reason
              }
            });
            }
          } else if (cmd.type === 'SCHEDULE_TASK') {
            // 处理定时提醒/定时任务指令
            try {
              let cronExpr: string;

              if (cmd.cron) {
                // 直接使用 cron 表达式
                cronExpr = cmd.cron;
              } else if (cmd.delay) {
                // 延时提醒：转换为一次性 cron（计算目标时间）
                const now = new Date();
                const delayMs = cmd.unit === 'hours'
                  ? cmd.delay * 60 * 60 * 1000
                  : cmd.delay * 60 * 1000;
                const target = new Date(now.getTime() + delayMs);
                cronExpr = `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
              } else {
                logger.warn('[Executor] SCHEDULE_TASK missing both cron and delay, skipping');
                continue;
              }

              const { createAndScheduleTask } = await import('../cron');
              const scheduledTask = createAndScheduleTask(
                `提醒: ${cmd.content.slice(0, 50)}`,
                cronExpr,
                task.context,
                cmd.content
              );
              logger.info(`[Executor] Created scheduled task: ${scheduledTask.id}, cron: ${cronExpr}, content: "${cmd.content}"`);
            } catch (e) {
              logger.error('[Executor] Failed to create scheduled task:', e);
            }
          } else if (cmd.type === 'UPDATE_SOUL') {
            // Agent 自我进化：更新 Soul 文件
            try {
              const { getSoulManager } = await import('../soul');
              const soulMgr = getSoulManager();
              const agentId = task.agentId || 'default';
              const section = cmd.section || 'Knowledge & Growth';
              const success = soulMgr.updateSoulSection(agentId, section, cmd.content);
              if (success) {
                logger.info(`[Executor] Soul updated for agent ${agentId}, section: ${section}`);
              } else {
                logger.warn(`[Executor] Failed to update soul section "${section}" for agent ${agentId}`);
              }
            } catch (e) {
              logger.error('[Executor] Failed to update soul:', e);
            }
          }
        }
      }

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
          signal,
          onProgress: async (message) => {
              lastProgressMessage = message;
          }
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
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      // 防御性处理：防止发送空内容导致 Lark 报错
      if (result.success && !result.output) {
        logger.warn('[Executor] Agent succeeded but output is empty. Providing default message.');
        result.output = '✅ 任务已执行完成，但未返回具体内容。';
      }

      await this.sendResult(task, result.success, result.output, result.error, duration, taskId);

      // [P1 Fix] 发送回复后立即移除 Typing indicator，不等 Evaluator
      if (typingState) {
        try {
          await removeTypingIndicator(typingState);
          logger.log('[Executor] Removed typing indicator after sendResult');
          typingState = null; // 标记已移除，finally 中不再重复操作
        } catch (e) {
          logger.warn('[Executor] Failed to remove typing indicator after sendResult:', e);
        }
      }

      // 注意：数据库状态更新已移至 WorkerEngine 层处理
      // 这里只需要负责业务逻辑

      // [P0 + P2 + P3 Fix] 三态任务分类：
      // 'greeting'/'simple' → 跳过 Evaluator/Reflection
      // 'chat' → 跳过 Evaluator（闲聊不需要元认知评估）
      // 'complex' → 通过 onComplete 触发元认知循环（异步，不阻塞）
      
      const evalTaskType = this.getTaskType(task.content);
      if (evalTaskType === 'greeting' || evalTaskType === 'simple') {
          logger.info(`[Executor] Simple/greeting task detected, skipping meta-cognitive loop`);
      } else if (evalTaskType === 'chat') {
          logger.info(`[Executor] Chat task detected, skipping Evaluator (no meta-cognitive overhead for casual conversation)`);
      } else {
          // [P2 Fix] Evaluator 异步化 — fire-and-forget，不阻塞主流程
          if (runOptions.onComplete) {
            logger.info(`[Executor] Complex task — firing Evaluator asynchronously`);
            runOptions.onComplete(taskId, result.success, result.output, duration).catch(e => {
              logger.error(`[Executor] Async Evaluator failed for ${taskId}:`, e);
            });
          }
      }

      logger.log('[Executor] Task completed:', taskId, 'duration:', duration, 'ms');
    } catch (error) {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[Executor] Task failed:', taskId, error);

      await this.sendError(task, errorMessage, taskId);

      if (runOptions.onError) {
        await runOptions.onError(taskId, errorMessage);
      }

      throw error;
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      // 兜底移除 Typing indicator（仅在 sendResult 后未能移除时触发）
      if (typingState) {
        try {
          await removeTypingIndicator(typingState);
          logger.log('[Executor] Removed typing indicator (finally fallback)');
        } catch (e) {
          logger.warn('[Executor] Failed to remove typing indicator in finally:', e);
        }
      }
    }
  }

  /**
   * 判断任务类型
   * 
   * @returns 'complex' | 'simple' | 'chat'
   * 
   * 设计原则：
   * 1. 宁可误判为复杂（多注入 prompt），不可误判为简单（丢失能力）
   * 2. 先检查复杂信号（一旦命中立即返回 'complex'）
   * 3. 再检查简单信号（纯问候/极短查询）→ 返回 'simple'
   * 4. 再检查闲聊信号（自我介绍/日常聊天）→ 返回 'chat'
   * 5. 默认视为复杂
   */
  private getTaskType(content: string): 'complex' | 'simple' | 'chat' | 'greeting' {
    if (!content) return 'simple';

    const text = content.toLowerCase();

    // === 阶段 1：复杂信号检测 — 命中任何一个就是复杂任务 ===
    const complexSignals = [
      // 动作类关键词（要求 Bot 做事）
      '写', '实现', '创建', '生成', '修改', '重构', '优化', '部署', '分析',
      '设计', '开发', '调试', 'debug', '修复', 'fix', '搭建', '配置',
      'write', 'create', 'build', 'implement', 'refactor', 'deploy', 'generate',
      // 定时/提醒类
      '提醒', '分钟后', '小时后', '定时', '闹钟', 'remind', 'schedule',
      // 代码/技术类
      '代码', 'code', '函数', 'function', '接口', 'api', '数据库', 'sql',
      // 多步骤指示
      '首先', '然后', '接着', '最后', '步骤', 'step',
      // 文件操作
      '文件', '目录', 'file', 'folder', '读取', '写入',
    ];

    if (complexSignals.some(sig => text.includes(sig))) {
      return 'complex';
    }

    // === 阶段 2：简单信号检测 — 纯问候/极短查询 ===
    
    // 纯问候语（精确匹配常见问候）
    const greetings = [
      '你好', '哈喽', '嗨', 'hello', 'hi', 'hey', '哈罗', '嘿',
      'good morning', 'good evening', '早上好', '晚上好', '下午好',
    ];
    if (greetings.some(g => text.trim() === g || text.trim() === g + '!') || text.trim() === '👋') {
      return 'greeting';
    }

    // 极短的纯查询（< 10 字符且无动作词）
    if (content.length < 10) {
      return 'simple';
    }

    // 查询类模式：以疑问词开头/结尾的短句
    const queryPatterns = [
      /^(你是谁|who are you)/,
      /^(几点|什么时间|what time)/,
      /(天气|weather)$/,
      /^(ping|pong|test)$/,
      /^\/?(help|帮助|菜单|menu)$/,
      /^\/?(status|状态)$/,
    ];
    if (content.length < 30 && queryPatterns.some(p => p.test(text.trim()))) {
      return 'simple';
    }

    // === 阶段 3：闲聊信号检测 — 自我介绍/日常聊天 ===
    const chatSignals = [
      // 自我介绍相关
      '我叫', '我是', '名字是', '我的名字',
      '来自', '在', '工作', '任职', '职位',
      '负责', '管理', '带领', '团队',
      // 个人生活相关
      '孩子', '女儿', '儿子', '家人', '家庭',
      '爱好', '喜欢', '擅长', '兴趣',
      // 日常闲聊
      '今天', '明天', '昨天', '周末', '假期',
      '吃饭', '休息', '下班', '上班',
    ];

    // 没有复杂信号，且包含闲聊关键词，长度适中
    if (chatSignals.some(sig => text.includes(sig)) && content.length < 200) {
      return 'chat';
    }

    // === 阶段 4：默认视为复杂 ===
    return 'complex';
  }

  /**
   * 兼容方法：旧代码中的 isSimpleTask 调用统一走 getTaskType
   * @returns true 如果是 greeting 或 simple 类型
   */
  private isSimpleTask(content: string): boolean {
    const type = this.getTaskType(content);
    return type === 'greeting' || type === 'simple';
  }

  /**
   * 快速回复：检测纯问候/打招呼，返回随机模板回复。
   * 命中时直接返回回复文本，不调 Claude CLI，延迟 < 100ms。
   */
  private tryQuickReply(content: string): string | null {
    if (!content) return null;
    const text = content.trim().toLowerCase();

    // 问候词精确匹配（含带感叹号变体）
    const greetings: Record<string, string[]> = {
      // 中文问候
      '你好': ['你好！有什么可以帮你的吗？', '你好呀 👋 有什么需要？', '你好～今天有什么我能帮忙的？'],
      '哈喽': ['哈喽！有什么可以帮你的？', '哈喽呀 👋 今天想做些什么？', '哈喽～有什么需要帮忙的吗？'],
      '嗨': ['嗨！有什么需要帮忙的？', '嗨嗨 👋 说吧，什么事？', '嗨～有什么我能做的？'],
      '嘿': ['嘿！有什么事吗？', '嘿 👋 我在，说吧～', '嘿～需要帮忙吗？'],
      '在吗': ['在的，有什么需要帮忙的？', '我在！请说～', '一直都在 😊 有什么事？'],
      '在不在': ['在的，有什么可以帮你的？', '我在，请说～'],
      '早': ['早上好！☀️ 今天有什么可以帮你的？', '早呀！新的一天，有什么计划？'],
      '早上好': ['早上好！☀️ 今天有什么可以帮你的？', '早上好呀！精神不错吧～有什么需要？'],
      '下午好': ['下午好！☕ 有什么可以帮你的？', '下午好呀！有什么需要帮忙的吗？'],
      '晚上好': ['晚上好！🌙 有什么可以帮你的？', '晚上好呀～还在忙吗？有什么需要？'],
      // English greetings
      'hello': ['Hello! 👋 How can I help you?', 'Hello! What can I do for you?', 'Hey there! How can I help?'],
      'hi': ['Hi! 👋 What can I help you with?', 'Hi there! How can I assist you?', 'Hi! What\'s up?'],
      'hey': ['Hey! 👋 What\'s up?', 'Hey there! How can I help?', 'Hey! What can I do for you?'],
      'good morning': ['Good morning! ☀️ How can I help?', 'Morning! What can I do for you today?'],
      'good afternoon': ['Good afternoon! ☕ How can I help?', 'Afternoon! What can I help you with?'],
      'good evening': ['Good evening! 🌙 How can I help?', 'Evening! What can I do for you?'],
    };

    // 去掉末尾标点符号后匹配
    const normalized = text.replace(/[!！?？~～。.，,]+$/, '');

    for (const [key, replies] of Object.entries(greetings)) {
      if (normalized === key) {
        return replies[Math.floor(Math.random() * replies.length)];
      }
    }

    // 表情符号
    if (['👋', '🙋', '🙋‍♂️', '🙋‍♀️', '😊', '🤗'].includes(text)) {
      const emojiReplies = ['👋 有什么可以帮你的？', '你好呀！有什么需要？', '嗨！我在，请说～'];
      return emojiReplies[Math.floor(Math.random() * emojiReplies.length)];
    }

    return null;
  }

  /**
   * 快速回复的发送方法：直接发送纯文本消息，不经过卡片/进度流程。
   */
  private async sendReply(task: QueueTask, reply: string, taskId: string): Promise<void> {
    try {
      // 快速回复以纯文本发送，回复到用户原消息上
      await sendText(task.context, reply, task.context.messageId);
    } catch (err) {
      logger.error(`[Executor] sendReply failed for ${taskId}:`, err);
      // 降级：尝试 sendMessageSmart
      try {
        await sendMessageSmart(task.context, reply, true, 0, taskId, task.context.messageId);
      } catch (fallbackErr) {
        logger.error(`[Executor] sendReply fallback also failed for ${taskId}:`, fallbackErr);
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
    percentage?: number,
    startTime?: number,
    onProgress?: TaskExecutorOptions['onProgress']
  ) {
    this.db.heartbeat(taskId);

    if (onProgress) {
      await onProgress(taskId, status, message, percentage);
    } else if (this.options.onProgress) {
      await this.options.onProgress(taskId, status, message, percentage);
    }

    const cardMessageId = this.db.getSetting(`card:${taskId}`);
    if (cardMessageId) {
      try {
        await updateCard(cardMessageId, buildProgressCard(status, message, percentage, taskId, startTime));
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

  private formatInboxForPrompt(messages: AgentMessage[]): string {
    if (messages.length === 0) return '';

    const lines = messages.map(m => {
      const from = m.fromSession;
      const time = m.createdAt;
      const type = m.messageType !== 'text' ? ` [${m.messageType}]` : '';
      return `### 来自 ${from}${type}（${time}）\n${m.message}`;
    });

    return `## 📬 收件箱 — 来自其他 Agent 的消息\n\n以下是其他 Agent 发给你的消息，请根据内容决定如何处理：\n\n${lines.join('\n\n---\n\n')}`;
  }

  private async triggerAgentIfNeeded(toSession: string, messageContent: string, sourceTask?: QueueTask) {
    const parsed = parseSessionKey(toSession);
    if (!parsed) return;

    logger.info(`[Executor] Triggering agent ${toSession} with message: ${messageContent.substring(0, 50)}...`);

    try {
      // 读取目标 Agent 的待处理消息
      const pendingMessages = this.db.readAgentMessages(toSession);
      if (pendingMessages.length === 0) {
        logger.warn(`[Executor] No pending messages for agent ${toSession}, skipping trigger`);
        return;
      }

      // 构建合成任务内容
      const syntheticContent = pendingMessages
        .map(m => `[From ${m.fromSession}]: ${m.message}`)
        .join('\n');

      const taskId = `agent-trigger-${parsed.agentId}-${Date.now()}`;

      // 构建完整的 QueueTask
      const syntheticTask: QueueTask = {
        id: taskId,
        type: 'message',
        context: sourceTask?.context || { userId: 'system', chatId: 'system', chatType: 'p2p' } as any,
        content: syntheticContent,
        retryCount: 0,
        maxRetries: 1,
        createdAt: Date.now(),
        sessionKey: toSession,
        agentId: parsed.agentId,
        correlationId: sourceTask?.correlationId,
        metadata: {
          triggerType: 'agent-to-agent',
          fromSession: sourceTask?.sessionKey,
        },
      };

      // 创建待处理任务并入队
      this.db.createPendingTask(taskId, syntheticTask, 'pending');

      const queue = getQueue();
      queue.enqueueTask(syntheticTask);

      logger.info(`[Executor] Agent ${parsed.agentId} triggered with task ${taskId}`);
    } catch (err) {
      logger.error(`[Executor] Failed to trigger agent ${toSession}:`, err);
    }
  }
}
