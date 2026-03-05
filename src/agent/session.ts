
/**
 * 生成标准化的 Agent Session Key
 */
export function makeSessionKey(agentId: string, context: string): string {
  return `agent:${agentId}:${context}`;
}

/**
 * 解析 Session Key
 */
export function parseSessionKey(key: string): { type: string; agentId: string; context: string } | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  return {
    type: parts[0],       // "agent" 或 "workflow"
    agentId: parts[1],    // "programmer", "reviewer" 等
    context: parts.slice(2).join(':'), // 剩余部分作为 context
  };
}
