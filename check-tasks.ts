#!/usr/bin/env bun

import { getDB } from './src/db';

const db = getDB();

console.log('='.repeat(60));
console.log('📋 当前定时任务列表');
console.log('='.repeat(60));

const allTasks = db.getScheduledTasks(false);
const enabledTasks = db.getScheduledTasks(true);

console.log(`\n总计: ${allTasks.length} 个任务（${enabledTasks.length} 个已启用）\n`);

if (allTasks.length === 0) {
  console.log('暂无定时任务。');
} else {
  for (const task of allTasks) {
    const status = task.enabled ? '✅ 已启用' : '❌ 已禁用';
    console.log(`\n📌 ${task.name}`);
    console.log(`   ID: ${task.id}`);
    console.log(`   Cron: ${task.cron}`);
    console.log(`   状态: ${status}`);
    console.log(`   创建时间: ${new Date(task.createdAt).toLocaleString('zh-CN')}`);
    console.log(`   更新时间: ${new Date(task.updatedAt).toLocaleString('zh-CN')}`);
    console.log(`   内容: ${task.content.substring(0, 100)}${task.content.length > 100 ? '...' : ''}`);
  }
}

// 检查每日统计的设置
console.log('\n' + '='.repeat(60));
console.log('📊 每日统计配置');
console.log('='.repeat(60));

const statsEnabled = db.getSetting('daily_stats:enabled');
const statsContext = db.getSetting('daily_stats:context');

console.log(`\n启用状态: ${statsEnabled === 'true' ? '✅ 已开启' : '❌ 已关闭'}`);
console.log(`通知上下文: ${statsContext ? '已配置' : '未配置'}`);

if (statsContext) {
  try {
    const ctx = JSON.parse(statsContext);
    console.log(`  - 用户ID: ${ctx.userId}`);
    console.log(`  - 会话ID: ${ctx.sessionId}`);
    console.log(`  - 聊天类型: ${ctx.chatType}`);
  } catch {
    console.log(`  - 上下文解析失败`);
  }
}

console.log('\n' + '='.repeat(60));

db.close();
