
export interface AgentCommand {
  type: 'AGENT_SEND' | 'TASK_DONE';
  to?: string;           // AGENT_SEND 的目标
  content: string;       // 消息内容或任务结果
  messageType?: string;  // 消息类型
  correlationId?: string;
  status?: 'success' | 'failed';
  reason?: string;
  metadata?: Record<string, unknown>;
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
