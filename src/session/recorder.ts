import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { TokenUsage } from '../types';
import { logger } from '../utils/logger';

const WORKSPACE_DIR = join(process.cwd(), 'workspace');
const SESSIONS_DIR = join(WORKSPACE_DIR, 'agents', 'sessions');

// 确保目录存在
function ensureDirExists() {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    logger.info('[SessionRecorder] Created sessions directory:', SESSIONS_DIR);
  }
}

// 生成简短的 ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// 获取当前日期字符串 (YYYY-MM-DD)
function getDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 获取 ISO 时间戳
function getTimestamp(): string {
  return new Date().toISOString();
}

// 会话记录事件类型
interface SessionEvent {
  type: 'session' | 'message' | 'custom';
  id: string;
  parentId?: string | null;
  timestamp: string;
}

interface SessionStartEvent extends SessionEvent {
  type: 'session';
  version: number;
  cwd: string;
}

interface MessageEvent extends SessionEvent {
  type: 'message';
  message: {
    role: 'user' | 'assistant';
    content: Array<{ type: 'text'; text: string }>;
    timestamp?: number;
  };
  api?: string;
  provider?: string;
  model?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason?: string;
}

export class SessionRecorder {
  private sessionId: string;
  private filePath: string;
  private lastEventId: string | null = null;
  private sessionStarted: boolean = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    const dateStr = getDateString();
    // 文件名格式: {date}_{sessionId}.jsonl - 方便按日期统计
    this.filePath = join(SESSIONS_DIR, `${dateStr}_${sessionId}.jsonl`);
    ensureDirExists();
  }

  private writeEvent(event: SessionEvent) {
    try {
      const line = JSON.stringify(event) + '\n';
      appendFileSync(this.filePath, line, 'utf-8');
      this.lastEventId = event.id;
    } catch (error) {
      logger.error('[SessionRecorder] Failed to write event:', error);
    }
  }

  // 开始会话
  startSession(cwd: string = process.cwd()) {
    if (this.sessionStarted) {
      return;
    }

    const event: SessionStartEvent = {
      type: 'session',
      version: 3,
      id: this.sessionId,
      timestamp: getTimestamp(),
      cwd,
    };

    this.writeEvent(event);
    this.sessionStarted = true;
    logger.info('[SessionRecorder] Session started:', this.sessionId);
  }

  // 记录用户消息
  recordUserMessage(content: string, metadata?: { messageId?: string; timestamp?: number }) {
    this.ensureSessionStarted();

    const event: MessageEvent = {
      type: 'message',
      id: generateId(),
      parentId: this.lastEventId,
      timestamp: getTimestamp(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: metadata?.timestamp,
      },
    };

    this.writeEvent(event);
    logger.debug('[SessionRecorder] Recorded user message');
  }

  // 记录助手消息
  recordAssistantMessage(
    content: string,
    options?: {
      tokenUsage?: TokenUsage;
      model?: string;
      stopReason?: string;
      timestamp?: number;
    }
  ) {
    this.ensureSessionStarted();

    const event: MessageEvent = {
      type: 'message',
      id: generateId(),
      parentId: this.lastEventId,
      timestamp: getTimestamp(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        timestamp: options?.timestamp,
      },
      api: 'claude-code',
      provider: 'anthropic',
      model: options?.model || 'claude',
      stopReason: options?.stopReason,
    };

    // 添加 token usage 数据
    if (options?.tokenUsage) {
      const tu = options.tokenUsage;
      event.usage = {
        input: tu.inputTokens,
        output: tu.outputTokens,
        cacheRead: tu.cacheReadInputTokens || 0,
        cacheWrite: tu.cacheCreationInputTokens || 0,
        totalTokens: tu.inputTokens + tu.outputTokens + (tu.cacheReadInputTokens || 0) + (tu.cacheCreationInputTokens || 0),
        cost: {
          input: 0, // 可以根据模型价格计算
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: tu.totalCostUsd || 0,
        },
      };
    }

    this.writeEvent(event);
    logger.debug('[SessionRecorder] Recorded assistant message', event.usage);
  }

  // 记录自定义事件
  recordCustom(customType: string, data: any) {
    this.ensureSessionStarted();

    const event = {
      type: 'custom' as const,
      customType,
      data,
      id: generateId(),
      parentId: this.lastEventId,
      timestamp: getTimestamp(),
    };

    this.writeEvent(event);
  }

  private ensureSessionStarted() {
    if (!this.sessionStarted) {
      this.startSession();
    }
  }

  getFilePath(): string {
    return this.filePath;
  }
}

// 会话记录器缓存
const recorderCache = new Map<string, SessionRecorder>();

export function getSessionRecorder(sessionId: string): SessionRecorder {
  let recorder = recorderCache.get(sessionId);
  if (!recorder) {
    recorder = new SessionRecorder(sessionId);
    recorderCache.set(sessionId, recorder);
  }
  return recorder;
}
