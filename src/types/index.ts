// 会话类型
export type ChatType = 'p2p' | 'group';

// 统一上下文接口
export interface ChatContext {
  chatType: ChatType;
  sessionId: string;
  userId: string;
  chatId?: string;
  messageId?: string;
  rootId?: string;
  threadId?: string;
}

// 飞书消息类型
export type LarkMessageType = 'text' | 'image' | 'audio' | 'file' | 'media' | 'post' | 'sticker' | 'share_chat' | 'share_user';

// 飞书消息事件
export interface LarkMessageEvent {
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: {
    sender: {
      sender_id: {
        union_id: string;
        user_id: string;
        open_id: string;
      };
      sender_type: string;
      tenant_key: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: 'p2p' | 'group';
      message_type: LarkMessageType;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          union_id: string;
          user_id: string;
          open_id: string;
        };
        name: string;
        tenant_key: string;
      }>;
    };
  };
}

// 解析后的消息附件信息
export interface MessageAttachment {
  type: 'image' | 'audio' | 'file' | 'media';
  fileKey: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  imageWidth?: number;
  imageHeight?: number;
  duration?: number; // 音频/视频时长（秒）
}

// 增强的队列任务 - 支持附件
export interface QueueTask {
  id: string;
  type: 'message' | 'scheduled';
  context: ChatContext;
  content: string;
  attachments?: MessageAttachment[];
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  scheduledTaskId?: string;
}

// 任务状态
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'timeout';

// 队列任务
export interface QueueTask {
  id: string;
  type: 'message' | 'scheduled';
  context: ChatContext;
  content: string;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  scheduledTaskId?: string;
}

// 历史消息
export interface HistoryMessage {
  role: string;
  content: string;
}

// 会话记录
export interface Session {
  id: string;
  sessionId: string;
  claudeSessionId?: string; // Claude CLI 的会话 ID
  chatType: ChatType;
  userId: string;
  chatId?: string;
  threadId?: string;
  history: HistoryMessage[];
  createdAt: number;
  updatedAt: number;
}

// 配置项
export interface Setting {
  key: string;
  value: string;
  updatedAt: number;
}

// 待处理任务（用于崩溃恢复）
export interface PendingTask {
  id: string;
  taskId: string;
  task: QueueTask;
  status: TaskStatus;
  workerId?: string;
  startedAt?: number;
  lastHeartbeatAt?: number;
  createdAt: number;
}

// 定时任务
export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  context: ChatContext;
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// Agent 选项
export interface AgentOptions {
  systemPrompt?: string;
  timeout?: number;
  workDir?: string;
  resumeSessionId?: string;
  streamOutput?: boolean;
  skipPermissions?: boolean;
  onStreamChunk?: (chunk: any) => void;
}

// Token 使用数据
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
}

// Agent 执行结果
export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  sessionId?: string;
  tokenUsage?: TokenUsage;
}

// 进度更新事件
export interface ProgressUpdate {
  taskId: string;
  status: TaskStatus;
  message: string;
  percentage?: number;
  cardMessageId?: string;
}

// 三层记忆配置
export interface MemoryConfig {
  agentIdentity: string;
  userProfile: string;
  conversationHistory?: string;
  memoryInjection?: string;
}

// ============ 长期记忆系统类型 ============

// 单个记忆事实
export interface MemoryFact {
  id: string;
  content: string;
  confidence: number; // 0-1，置信度
  source: 'conversation' | 'explicit'; // 来源：对话中提取或用户明确设定
  timestamp: number;
}

// 用户上下文
export interface UserContext {
  work?: string;
  personal?: string;
  currentFocus?: string;
}

// 历史背景
export interface HistoryContext {
  recentMonths?: string;
  earlier?: string;
  longTerm?: string;
}

// 完整的长期记忆数据结构
export interface LongTermMemory {
  version: '1.0';
  userId: string;
  userContext: UserContext;
  history: HistoryContext;
  facts: MemoryFact[];
  createdAt: number;
  updatedAt: number;
}

// 记忆系统配置
export interface MemorySystemConfig {
  enabled: boolean;
  debounceSeconds: number; // 防抖时间（秒）
  maxFacts: number; // 最多存储的事实数量
  factConfidenceThreshold: number; // 事实置信度阈值
  injectionEnabled: boolean; // 是否注入到 system prompt
  maxInjectionChars: number; // 注入时的最大字符数
}

// 待处理的记忆更新队列项
export interface PendingMemoryUpdate {
  userId: string;
  messages: HistoryMessage[];
  addedAt: number;
}

// 记忆提取结果（LLM 返回的格式）
export interface MemoryExtractionResult {
  userContext?: Partial<UserContext>;
  newFacts?: Array<{
    content: string;
    confidence: number;
  }>;
}

