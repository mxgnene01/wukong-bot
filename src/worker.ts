import { loadConfig, getConfig } from './config';
import { startWorker, stopWorker } from './worker/index';
import { startCronScheduler } from './cron';
import { getDB } from './db';

// 加载配置
const config = loadConfig();
const db = getDB();

console.log('='.repeat(60));
console.log(`${config.app.name} v${config.app.version} - Worker Only`);
console.log('='.repeat(60));
console.log('Worker ID:', config.worker.id);
console.log('Max concurrent tasks:', config.worker.maxConcurrentTasks);
console.log('');

startWorker();
startCronScheduler();

console.log('Worker started');

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  stopWorker();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  stopWorker();
  db.close();
  process.exit(0);
});
