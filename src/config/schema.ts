import path from 'path';

// 参考 deer-flow 的配置系统设计

export interface Config {
  app: AppConfig;
  lark: LarkConfig;
  claude: ClaudeConfig;
  database: DatabaseConfig;
  queue: QueueConfig;
  worker: WorkerConfig;
  skills: SkillsConfig;
  memory: MemoryConfig;
  middleware: MiddlewareConfig;
  logging: LoggingConfig;
  workflow: WorkflowConfig;
}

export interface WorkflowConfig {
  enabled: boolean;
  workflowsDir: string;
  defaultTimeoutMs: number;
  maxConcurrentWorkflows: number;
}

export interface AppConfig {
  name: string;
  version: string;
  env: 'development' | 'production' | 'test';
  port: number;
  workDir: string;
  eventSource: 'websocket' | 'webhook';
}

export interface LarkConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

export interface ClaudeConfig {
  cliPath: string;
  model?: string;
  timeout: number;
  maxRetries: number;
}

export interface DatabaseConfig {
  path: string;
  enableWal: boolean;
  busyTimeout: number;
}

export interface QueueConfig {
  maxSize: number;
  defaultMaxRetries: number;
  retryDelayMs: number;
}

export interface WorkerConfig {
  id: string;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
}

export interface SkillsConfig {
  enabled: boolean;
  skillsDir: string;
  autoLoad: boolean;
}

export interface MemoryConfig {
  maxHistoryLength: number;
  enableSummary: boolean;
  summaryThreshold: number;
}

export interface MiddlewareConfig {
  enabled: string[];
  order: string[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'log';
  enableFile: boolean;
  enableConsole: boolean;
}

// 默认配置
const workDir = process.env.WORK_DIR || process.cwd();

export const defaultConfig: Config = {
  app: {
    name: 'Wukong Bot',
    version: '2.1.0',
    env: (process.env.NODE_ENV as any) || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    workDir: workDir,
    eventSource: (process.env.EVENT_SOURCE as any) || 'webhook',
  },
  lark: {
    appId: process.env.APP_ID || '',
    appSecret: process.env.APP_SECRET || '',
    encryptKey: process.env.ENCRYPT_KEY,
    verificationToken: process.env.VERIFICATION_TOKEN,
  },
  claude: {
    cliPath: process.env.CLAUDE_CODE_PATH || 'claude',
    model: process.env.CLAUDE_MODEL,
    timeout: parseInt(process.env.CLAUDE_TIMEOUT || '1800000', 10),
    maxRetries: parseInt(process.env.CLAUDE_MAX_RETRIES || '1', 10),
  },
  database: {
    path: path.join(workDir, 'data', 'wukong.db'),
    enableWal: true,
    busyTimeout: 5000,
  },
  queue: {
    maxSize: 1000,
    defaultMaxRetries: 1,
    retryDelayMs: 1000,
  },
  worker: {
    id: process.env.WORKER_ID || crypto.randomUUID(),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),
    taskTimeoutMs: parseInt(process.env.TASK_TIMEOUT || '1800000', 10),
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10),
  },
  skills: {
    enabled: true,
    skillsDir: path.join(workDir, 'skills'),
    autoLoad: true,
  },
  memory: {
    maxHistoryLength: 100,
    enableSummary: true,
    summaryThreshold: 50,
  },
  middleware: {
    enabled: ['duplicate_check', 'context_builder', 'session_manager', 'skill_loader', 'rate_limit'],
    order: ['duplicate_check', 'context_builder', 'session_manager', 'skill_loader', 'rate_limit'],
  },
  logging: {
    level: (process.env.LOG_LEVEL as any) || 'info',
    enableFile: process.env.LOG_ENABLE_FILE !== 'false',
    enableConsole: process.env.LOG_ENABLE_CONSOLE !== 'false',
  },
  workflow: {
    enabled: process.env.WORKFLOW_ENABLED !== 'false',
    workflowsDir: path.join(workDir, 'workflows'),
    defaultTimeoutMs: parseInt(process.env.WORKFLOW_DEFAULT_TIMEOUT || '1800000', 10),
    maxConcurrentWorkflows: parseInt(process.env.MAX_CONCURRENT_WORKFLOWS || '10', 10),
  },
};

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!config.lark.appId) errors.push('lark.appId is required');
  if (!config.lark.appSecret) errors.push('lark.appSecret is required');
  if (!config.claude.cliPath) errors.push('claude.cliPath is required');

  return errors;
}
