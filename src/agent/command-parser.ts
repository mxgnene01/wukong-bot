
export interface AgentCommand {
  type: 'AGENT_SEND' | 'TASK_DONE' | 'SCHEDULE_TASK' | 'UPDATE_SOUL';
  to?: string;           // AGENT_SEND 的目标
  content: string;       // 消息内容或任务结果
  messageType?: string;  // 消息类型
  correlationId?: string;
  status?: 'success' | 'failed';
  reason?: string;
  metadata?: Record<string, unknown>;
  // SCHEDULE_TASK 专用字段
  delay?: number;        // 延时（分钟）
  unit?: string;         // 延时单位（minutes/hours）
  cron?: string;         // cron 表达式
  // UPDATE_SOUL 专用字段
  section?: string;      // Soul 章节名
}

/**
 * 从 Claude Code CLI 的输出中解析 Agent 通信指令
 *
 * 支持格式：
 *   [AGENT_SEND to="xxx" type="xxx"] content [/AGENT_SEND]
 *   [TASK_DONE status="success"] content [/TASK_DONE]
 */
export function parseAgentCommands(output: string): AgentCommand[] {
  const commands: AgentCommand[] = [];

  // 解析 AGENT_SEND
  const sendRegex = /\[AGENT_SEND\s+([^\]]*)\]([\s\S]*?)\[\/AGENT_SEND\]/g;
  let match: RegExpExecArray | null;

  while ((match = sendRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'AGENT_SEND',
      to: attrs.to,
      content,
      messageType: attrs.type || 'text',
      correlationId: attrs.correlation_id,
    });
  }

  // 解析 TASK_DONE
  const doneRegex = /\[TASK_DONE\s+([^\]]*)\]([\s\S]*?)\[\/TASK_DONE\]/g;

  while ((match = doneRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'TASK_DONE',
      content,
      status: (attrs.status as 'success' | 'failed') || 'success',
      reason: attrs.reason,
    });
  }

  // 解析 SCHEDULE_TASK（定时提醒/定时任务）
  const scheduleRegex = /\[SCHEDULE_TASK\s+([^\]]*)\]([\s\S]*?)\[\/SCHEDULE_TASK\]/g;

  while ((match = scheduleRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'SCHEDULE_TASK',
      content,
      delay: attrs.delay ? parseInt(attrs.delay, 10) : undefined,
      unit: attrs.unit || 'minutes',
      cron: attrs.cron,
    });
  }

  // 解析 UPDATE_SOUL（Agent 自我进化）
  // 格式: [UPDATE_SOUL section="Knowledge & Growth"]新内容[/UPDATE_SOUL]
  const soulRegex = /\[UPDATE_SOUL\s+([^\]]*)\]([\s\S]*?)\[\/UPDATE_SOUL\]/g;

  while ((match = soulRegex.exec(output)) !== null) {
    const attrs = parseAttributes(match[1]);
    const content = match[2].trim();

    commands.push({
      type: 'UPDATE_SOUL',
      content,
      section: attrs.section || 'Knowledge & Growth',
    });
  }

  return commands;
}

/**
 * 解析属性字符串，如 'to="xxx" type="yyy"'
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }

  return attrs;
}
