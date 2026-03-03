import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config';

const LOG_DIR = './workspace/logs';

// 日志级别优先级
const LOG_LEVELS = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// 确保日志目录存在
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFileName(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD (local time)
  return join(LOG_DIR, `${dateStr}.log`);
}

function formatMessage(level: string, ...args: any[]): string {
  const now = new Date();
  // 使用本地时间格式的 ISO 字符串
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  const timestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;

  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  return `[${timestamp}] [${level}] ${message}\n`;
}

function shouldLog(level: string): boolean {
  try {
    const config = getConfig();
    const currentLevel = LOG_LEVELS[config.logging.level as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info;
    const messageLevel = LOG_LEVELS[level as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info;
    return messageLevel >= currentLevel;
  } catch {
    // 如果配置加载失败，默认只显示 info 及以上级别
    return LOG_LEVELS[level as keyof typeof LOG_LEVELS] >= LOG_LEVELS.info;
  }
}

function getLoggingConfig() {
  try {
    return getConfig().logging;
  } catch {
    return { enableFile: true, enableConsole: true };
  }
}

export const logger = {
  log(...args: any[]) {
    if (!shouldLog('log')) return;

    const message = formatMessage('LOG', ...args);
    const config = getLoggingConfig();

    if (config.enableConsole) {
      console.log(...args);
    }
    if (config.enableFile) {
      try {
        appendFileSync(getLogFileName(), message);
      } catch (e) {
        console.error('Failed to write log:', e);
      }
    }
  },

  info(...args: any[]) {
    if (!shouldLog('info')) return;

    const message = formatMessage('INFO', ...args);
    const config = getLoggingConfig();

    if (config.enableConsole) {
      console.info(...args);
    }
    if (config.enableFile) {
      try {
        appendFileSync(getLogFileName(), message);
      } catch (e) {
        console.error('Failed to write log:', e);
      }
    }
  },

  warn(...args: any[]) {
    if (!shouldLog('warn')) return;

    const message = formatMessage('WARN', ...args);
    const config = getLoggingConfig();

    if (config.enableConsole) {
      console.warn(...args);
    }
    if (config.enableFile) {
      try {
        appendFileSync(getLogFileName(), message);
      } catch (e) {
        console.error('Failed to write log:', e);
      }
    }
  },

  error(...args: any[]) {
    if (!shouldLog('error')) return;

    const message = formatMessage('ERROR', ...args);
    const config = getLoggingConfig();

    if (config.enableConsole) {
      console.error(...args);
    }
    if (config.enableFile) {
      try {
        appendFileSync(getLogFileName(), message);
      } catch (e) {
        console.error('Failed to write log:', e);
      }
    }
  },

  debug(...args: any[]) {
    if (!shouldLog('debug')) return;

    const message = formatMessage('DEBUG', ...args);
    const config = getLoggingConfig();

    if (config.enableConsole) {
      console.debug(...args);
    }
    if (config.enableFile) {
      try {
        appendFileSync(getLogFileName(), message);
      } catch (e) {
        console.error('Failed to write log:', e);
      }
    }
  },
};
