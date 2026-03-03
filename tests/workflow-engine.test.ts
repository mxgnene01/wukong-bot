
import { describe, it, expect, beforeEach } from 'bun:test';
import { WorkflowEngine } from '../src/workflow/engine';
import { getDB } from '../src/db/index';
import { getQueue } from '../src/queue/index';

const db = getDB();
const queue = getQueue();
const engine = new WorkflowEngine();

describe('Workflow Engine', () => {
  beforeEach(() => {
    // @ts-ignore
    db.db.exec('DELETE FROM workflow_runs');
    // @ts-ignore
    db.db.exec('DELETE FROM agent_messages');
    // @ts-ignore
    db.db.exec('DELETE FROM pending_tasks');
    // @ts-ignore
    queue.tasks.clear();
  });

  it('should execute a simple workflow step', async () => {
    // 注册一个简单的工作流
    engine.registerWorkflow({
      id: 'test-workflow',
      name: 'Test Workflow',
      steps: [
        {
          id: 'step1',
          name: 'Step 1',
          agentId: 'agent1',
          task: 'Task 1: ${inputs.message}',
        }
      ],
    });

    // 启动工作流
    const runId = await engine.startWorkflow('test-workflow', { message: 'hello' }, 'user1');
    expect(runId).toBeDefined();

    const run = engine.getRun(runId)!;
    expect(run.status).toBe('running');
    
    // 等待 step1 被调度
    await new Promise(resolve => setTimeout(resolve, 500)); 
    expect(run.steps.step1.status).toBe('running');
    
    // 检查数据库中是否有任务
    // @ts-ignore
    const pendingTasks = db.db.prepare('SELECT * FROM pending_tasks').all();
    expect(pendingTasks.length).toBeGreaterThan(0);
    const taskRow = pendingTasks.find((t: any) => t.taskId.length > 0) as any; // find the task
    // 注意：可能还有旧的任务如果 cleanup 没做好，但我们 beforeEach 做了 delete
    expect(taskRow).toBeDefined();
    
    const taskObj = JSON.parse(taskRow.task);
    expect(taskObj.content).toBe('Task 1: hello');
    expect(taskObj.sessionKey).toBeDefined();
    
    // 模拟 Worker 完成任务并回复
    // 注意：这里我们模拟 Executor 的行为
    const correlationId = taskObj.correlationId!;
    const replyTo = `workflow:${runId}`;
    
    db.sendAgentMessage({
      fromSession: taskObj.sessionKey!, // from
      toSession: replyTo,               // to
      message: 'Step 1 Completed',
      messageType: 'task_result',
      correlationId,
      metadata: { status: 'success' }
    });
    
    // 等待引擎处理回复
    await new Promise(resolve => setTimeout(resolve, 500));
    
    expect(run.steps.step1.status).toBe('completed');
    expect(run.steps.step1.output).toBe('Step 1 Completed');
    expect(run.status).toBe('completed');
  });
});
