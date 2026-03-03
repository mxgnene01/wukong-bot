
import { describe, it, expect, beforeEach } from 'bun:test';
import { getDB } from '../src/db/index';
import { parseAgentCommands } from '../src/agent/command-parser';

const db = getDB();

describe('Agent Messaging', () => {
  beforeEach(() => {
    // 清空测试数据
    // @ts-ignore
    db.db.exec('DELETE FROM agent_messages');
  });

  it('should send and receive messages between agents', () => {
    // Agent A 发送消息给 Agent B
    const msgId = db.sendAgentMessage({
      fromSession: 'agent:programmer:project-1',
      toSession: 'agent:reviewer:project-1',
      message: '代码已完成，请审查：\n```\nfunction add(a, b) { return a + b; }\n```',
      messageType: 'task_result'
    });

    expect(msgId).toBeGreaterThan(0);

    // Agent B 读取消息
    const messages = db.readAgentMessages('agent:reviewer:project-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].fromSession).toBe('agent:programmer:project-1');
    expect(messages[0].messageType).toBe('task_result');

    // 再次读取应该为空（已标记为 read）
    const messagesAgain = db.readAgentMessages('agent:reviewer:project-1');
    expect(messagesAgain).toHaveLength(0);
  });

  it('should parse AGENT_SEND commands from CLI output', () => {
    const output = `
好的，我已经完成了代码编写。现在通知审查 Agent。

[AGENT_SEND to="agent:reviewer:project-1" type="task_result"]
## 代码变更摘要
- 新增 add() 函数
- 新增单元测试
- 修改了 package.json
[/AGENT_SEND]

[TASK_DONE status="success"]
代码编写完成，已通知 reviewer 进行审查。
[/TASK_DONE]
    `;

    const commands = parseAgentCommands(output);
    expect(commands).toHaveLength(2);
    expect(commands[0].type).toBe('AGENT_SEND');
    expect(commands[0].to).toBe('agent:reviewer:project-1');
    expect(commands[1].type).toBe('TASK_DONE');
    expect(commands[1].status).toBe('success');
  });

  it('should support synchronous wait for reply', async () => {
    const correlationId = 'review-request-001';

    // 模拟异步回复
    setTimeout(() => {
      db.sendAgentMessage({
        fromSession: 'agent:reviewer:project-1',
        toSession: 'agent:programmer:project-1',
        message: '审查通过，代码质量良好。',
        messageType: 'task_result',
        correlationId
      });
    }, 500);

    // 等待回复
    const reply = await db.waitForReply('agent:programmer:project-1', correlationId, 5000);
    expect(reply).not.toBeNull();
    expect(reply!.message).toContain('审查通过');
  });
});
