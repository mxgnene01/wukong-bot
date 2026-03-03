
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { getConfig } from '../config';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface CleanupRule {
  dir: string;
  maxAgeDays: number;
  pattern?: RegExp;
}

export async function runCleanup() {
  const config = getConfig();
  const workDir = config.app.workDir;

  const rules: CleanupRule[] = [
    {
      dir: path.join(workDir, 'logs'),
      maxAgeDays: 14, // 日志保留 14 天
      pattern: /\.log$/
    },
    {
      dir: path.join(workDir, 'agents', 'sessions'),
      maxAgeDays: 30, // Session 记录保留 30 天
      pattern: /\.jsonl$/
    },
    {
      dir: path.join(workDir, 'images'),
      maxAgeDays: 7, // 图片缓存保留 7 天
      pattern: /\.(jpg|jpeg|png|gif|webp)$/i
    }
  ];

  logger.info('[Cleanup] Starting disk cleanup...');

  for (const rule of rules) {
    await cleanupDirectory(rule);
  }

  logger.info('[Cleanup] Disk cleanup completed');
}

async function cleanupDirectory(rule: CleanupRule) {
  try {
    if (!fs.existsSync(rule.dir)) {
      return;
    }

    const files = await fs.promises.readdir(rule.dir);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      if (rule.pattern && !rule.pattern.test(file)) {
        continue;
      }

      const filePath = path.join(rule.dir, file);
      try {
        const stats = await fs.promises.stat(filePath);
        const ageMs = now - stats.mtimeMs;
        const ageDays = ageMs / ONE_DAY_MS;

        if (ageDays > rule.maxAgeDays) {
          await fs.promises.unlink(filePath);
          deletedCount++;
          logger.debug(`[Cleanup] Deleted old file: ${file} (${Math.round(ageDays)} days old)`);
        }
      } catch (e) {
        // 忽略单个文件错误
      }
    }

    if (deletedCount > 0) {
      logger.info(`[Cleanup] Cleaned ${deletedCount} files in ${rule.dir}`);
    }
  } catch (error) {
    logger.error(`[Cleanup] Failed to clean directory ${rule.dir}:`, error);
  }
}
