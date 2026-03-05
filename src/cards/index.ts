import type { TaskStatus } from '../types';
import type { DailyStats } from '../stats/daily';

interface CardElement {
  tag: string;
  text?: { tag: string; content: string };
  elements?: CardElement[];
  content?: string;
  value?: any;
  [key: string]: any;
}

interface LarkCard {
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
    update_multi?: boolean;
  };
  header?: {
    title: { tag: string; content: string };
    template?: string;
  };
  elements: CardElement[];
}

export function buildProgressCard(
  status: TaskStatus,
  message: string,
  percentage?: number,
  taskId?: string,
  startTime?: number
): LarkCard {
  const template = getStatusTemplate(status);
  let title = getStatusTitle(status);

  // 计算耗时
  let durationStr = '';
  if (startTime) {
    const duration = Date.now() - startTime;
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      durationStr = `${hours}h${minutes % 60}m`;
    } else if (minutes > 0) {
      durationStr = `${minutes}m${seconds % 60}s`;
    } else {
      durationStr = `${seconds}s`;
    }
  }

  // 如果正在处理中，尝试使用更紧凑的标题样式：[ID] ⏳ 进度% 耗时
  if (status === 'processing') {
    const idStr = taskId ? taskId.slice(0, 8) : '';
    const progressStr = percentage !== undefined ? `${percentage}%` : '';
    const parts = [];
    
    // 组合标题: 处理中 [ID] ⏳ 45% 1m30s
    if (idStr) parts.push(`[${idStr}]`);
    if (progressStr || durationStr) parts.push('⏳');
    if (progressStr) parts.push(progressStr);
    if (durationStr) parts.push(durationStr);
    
    if (parts.length > 0) {
      title = `${getStatusTitle(status)} ${parts.join(' ')}`;
    }
  }

  let displayMessage = message;
  if (percentage !== undefined) {
    displayMessage = `${message}\n\n进度: ${percentage}%`;
  }

  const elements: CardElement[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: displayMessage,
      },
    },
  ];

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: `任务 ID: ${taskId || 'N/A'}` },
      { tag: 'plain_text', content: ` | ` },
      { tag: 'plain_text', content: `更新时间: ${new Date().toLocaleString('zh-CN')}` },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    elements,
  };
}

export function buildResultCard(
  success: boolean,
  output: string,
  duration: number,
  taskId?: string
): LarkCard {
  const elements: CardElement[] = [];

  let displayOutput = output;
  // 飞书卡片文本元素最大支持 30KB，这里放宽限制到 20000 字符
  if (displayOutput.length > 20000) {
    displayOutput = displayOutput.slice(0, 20000) + '...\n\n[输出已截断]';
  }

  // 移除开头可能存在的多余换行符
  displayOutput = displayOutput.replace(/^[\n\r]+/, '');

  // 修复飞书卡片中 \n\n 无法渲染为换行的问题
  // 飞书 Markdown 有时需要显式的 <br> 或者特殊的换行处理
  // 但更常见的问题是 JSON.stringify 后 \n 被转义。
  // 我们使用全局替换将字面量 "\n" 替换为换行符
  displayOutput = displayOutput.replace(/\\n/g, '\n').replace(/\\\\n/g, '\\n');

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: success
        ? `${displayOutput}`
        : `**执行失败**\n\n\`\`\`\n${displayOutput}\n\`\`\``,
    },
  });

  // 只有在非成功状态下才显示分割线和底部信息，
  // 或者当内容真的很长需要额外信息时。
  // 对于普通的对话回复，去掉这些会让界面更清爽。
  if (!success) {
    elements.push({
      tag: 'hr',
    });

    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `耗时: ${(duration / 1000).toFixed(1)}s` },
        { tag: 'plain_text', content: ` | ` },
        { tag: 'plain_text', content: `任务 ID: ${taskId || 'N/A'}` },
      ],
    });
  }

  const card: LarkCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    elements,
  };

  // 只有在失败时才显示 Header，成功时像普通消息一样展示
  if (!success) {
    card.header = {
      title: {
        tag: 'plain_text',
        content: '执行失败',
      },
      template: 'red',
    };
  }

  return card;
}

export function buildErrorCard(error: string, taskId?: string): LarkCard {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '出错了',
      },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**错误信息**:\n\n\`\`\`\n${error}\n\`\`\``,
        },
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: `任务 ID: ${taskId || 'N/A'}` },
        ],
      },
    ],
  };
}

export function buildWelcomeCard(): any {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        content: '👋 你好！我是 Wukong Bot',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          content: '我是您的 AI 编程助手，可以帮您：\n\n🔹 **编写代码**：告诉我需求，我来实现\n🔹 **审查代码**：发送代码片段，我来 Review\n🔹 **解答疑惑**：随时问我任何技术问题\n\n直接发送消息即可开始对话！',
          tag: 'lark_md',
        },
      },
    ],
  };
}

function getStatusTemplate(status: TaskStatus): string {
  const templates: Record<TaskStatus, string> = {
    pending: 'grey',
    processing: 'blue',
    completed: 'green',
    failed: 'red',
    timeout: 'orange',
  };
  return templates[status] || 'grey';
}

function getStatusTitle(status: TaskStatus): string {
  const titles: Record<TaskStatus, string> = {
    pending: '任务排队中',
    processing: '处理中',
    completed: '已完成',
    failed: '执行失败',
    timeout: '执行超时',
  };
  return titles[status] || '处理中';
}

export function buildDailyStatsCard(stats: DailyStats): LarkCard {
  const elements: CardElement[] = [];

  // 摘要部分
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `📊 **每日统计报告**\n\n**日期**: ${stats.date}`,
    },
  });

  elements.push({ tag: 'hr' });

  // 消息统计
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**🔢 消息统计**\n` +
        `• 用户消息: ${stats.userMessageCount.toLocaleString()}\n` +
        `• 助手消息: ${stats.assistantMessageCount.toLocaleString()}\n` +
        `• 会话数量: ${stats.totalSessionCount.toLocaleString()}`,
    },
  });

  elements.push({ tag: 'hr' });

  // Token 统计
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**💰 Token 使用**\n` +
        `• 输入: ${stats.totalInputTokens.toLocaleString()}\n` +
        `• 输出: ${stats.totalOutputTokens.toLocaleString()}\n` +
        `• 缓存读取: ${stats.totalCacheReadTokens.toLocaleString()}\n` +
        `• 缓存写入: ${stats.totalCacheWriteTokens.toLocaleString()}\n` +
        `• **总计**: ${stats.totalTokens.toLocaleString()}`,
    },
  });

  elements.push({ tag: 'hr' });

  // 成本
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**💸 总成本**\n\n$${stats.totalCostUsd.toFixed(4)}`,
    },
  });

  // 会话详情（如果有）
  if (stats.sessions.length > 0) {
    elements.push({ tag: 'hr' });

    let sessionDetails = '**📋 会话详情**\n';
    for (const session of stats.sessions.slice(0, 5)) {
      sessionDetails +=
        `• ${session.sessionId.slice(0, 8)}...: ` +
        `${session.totalTokens.toLocaleString()} tokens, ` +
        `$${session.costUsd.toFixed(4)}\n`;
    }
    if (stats.sessions.length > 5) {
      sessionDetails += `... 还有 ${stats.sessions.length - 5} 个会话`;
    }

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: sessionDetails,
      },
    });
  }

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: `生成时间: ${new Date().toLocaleString('zh-CN')}` },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: false,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '📊 每日统计报告',
      },
      template: 'blue',
    },
    elements,
  };
}

export type { LarkCard };
