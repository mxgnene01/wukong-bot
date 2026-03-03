#!/usr/bin/env bun

import { loadConfig } from './src/config';
import { getDB } from './src/db';
import { setDailyStatsContext, setDailyStatsEnabled } from './src/stats';

loadConfig();

const db = getDB();

console.log('='.repeat(60));
console.log('📊 启用每日统计');
console.log('='.repeat(60));
console.log('');

// 注意：在实际使用中，ChatContext 需要从真实的聊天中获取
// 这里创建一个模拟的上下文用于演示
const mockContext = {
  chatType: 'p2p' as const,
  sessionId: 'demo-session',
  userId: 'demo-user',
  chatId: 'demo-chat',
};

console.log('📝 设置通知上下文...');
setDailyStatsContext(mockContext);
console.log('✅ 通知上下文已设置');

console.log('🔔 启用每日统计...');
setDailyStatsEnabled(true);
console.log('✅ 每日统计已启用');

console.log('');
console.log('='.repeat(60));
console.log('✅ 每日统计已启用！');
console.log('='.repeat(60));
console.log('');
console.log('📋 配置信息:');
console.log('   • 发送时间: 每天 23:00');
console.log('   • 统计内容: Token 用量、消息数、会话数');
console.log('');
console.log('💡 提示: 在实际的飞书对话中，直接对我说');
console.log('   "开启每日统计" 即可自动配置！');

db.close();
