// 兼容性层 - 新代码请使用 src/config/index.ts
import { getConfig, loadConfig } from '../config';

let loaded = false;

function ensureLoaded() {
  if (!loaded) {
    loadConfig();
    loaded = true;
  }
}

export const config = new Proxy({} as any, {
  get(_, prop) {
    ensureLoaded();
    const cfg = getConfig();

    switch (prop) {
      case 'appId': return cfg.lark.appId;
      case 'appSecret': return cfg.lark.appSecret;
      case 'claudeCodePath': return cfg.claude.cliPath;
      case 'workDir': return cfg.app.workDir;
      case 'port': return cfg.app.port;
      case 'dbPath': return cfg.database.path;
      case 'heartbeatInterval': return cfg.worker.heartbeatIntervalMs;
      case 'taskTimeout': return cfg.worker.taskTimeoutMs;
      case 'pm2Name': return 'wukong-bot';
      case 'maxRetries': return cfg.claude.maxRetries;
      case 'workerId': return cfg.worker.id;
      default: return undefined;
    }
  },
});

export function validateConfig() {
  loadConfig();
}
