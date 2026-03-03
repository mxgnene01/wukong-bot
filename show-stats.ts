#!/usr/bin/env bun

import { calculateDailyStats, formatStatsReport } from './src/stats/daily';
import { loadConfig } from './src/config';

// 先加载配置
loadConfig();

console.log('='.repeat(60));
console.log('📊 今日 Token 用量统计');
console.log('='.repeat(60));
console.log('');

const stats = calculateDailyStats();
console.log(formatStatsReport(stats));
