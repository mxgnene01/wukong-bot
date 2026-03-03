import { loadConfig, getConfig } from './config';
import { gatewayApp } from './gateway/index';
import { getDB } from './db';
import { initSkills } from './skills';

// 加载配置
const config = loadConfig();
const db = getDB();

console.log('='.repeat(60));
console.log(`${config.app.name} v${config.app.version} - Gateway Only`);
console.log('='.repeat(60));
console.log('Environment:', config.app.env);
console.log('Port:', config.app.port);
console.log('');

// 初始化技能
initSkills();

// 启动 Gateway
const server = Bun.serve({
  port: config.app.port,
  fetch: gatewayApp.fetch,
});

console.log(`Gateway server listening on ${server.url}`);
console.log('');
console.log('Ready to accept messages!');

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  db.close();
  process.exit(0);
});
