
import { WorkflowEngine } from '../workflow/engine';
import { sendText } from '../lark/client';
import path from 'path';

const workflowEngine = new WorkflowEngine();

// 简单的事件监听，避免重复添加
let listenersAdded = false;

// 初始化
let initialized = false;
export async function initWorkflowEngine() {
  if (initialized) return;
  const workflowsDir = path.resolve(process.cwd(), 'workspace/workflows');
  await workflowEngine.loadWorkflowsFromDir(workflowsDir);
  
  if (!listenersAdded) {
    setupListeners();
    listenersAdded = true;
  }
  
  initialized = true;
  console.log('[Workflow] Engine initialized');
}

function setupListeners() {
  workflowEngine.on('step:completed', async (event) => {
    const run = workflowEngine.getRun(event.runId);
    if (run && run.triggeredBy) {
      await sendText({ userId: run.triggeredBy, chatType: 'p2p', sessionId: '' }, `✅ 步骤 **${event.stepId}** 完成`);
    }
  });

  workflowEngine.on('workflow:completed', async (event) => {
    const run = workflowEngine.getRun(event.runId);
    if (run && run.triggeredBy) {
      await sendText({ userId: run.triggeredBy, chatType: 'p2p', sessionId: '' }, `🎉 工作流全部完成！`);
    }
  });

  workflowEngine.on('workflow:failed', async (event) => {
    const run = workflowEngine.getRun(event.runId);
    if (run && run.triggeredBy) {
      await sendText({ userId: run.triggeredBy, chatType: 'p2p', sessionId: '' }, `❌ 工作流失败: ${event.error}`);
    }
  });
}

/**
 * 检测用户消息是否要触发工作流
 */
export function detectWorkflowTrigger(message: string): {
  workflowId: string;
  inputs: Record<string, unknown>;
} | null {
  // 方式1：显式指令
  const cmdMatch = message.match(/^\/(?:workflow|pipeline)\s+(\S+)\s*(.*)/s);
  if (cmdMatch) {
    const workflowId = cmdMatch[1];
    const argsStr = cmdMatch[2].trim();

    // 解析 --key value 参数
    const inputs: Record<string, unknown> = {};
    const argRegex = /--(\w+)\s+"([^"]+)"|--(\w+)\s+(\S+)/g;
    let argMatch;
    while ((argMatch = argRegex.exec(argsStr)) !== null) {
      const key = argMatch[1] || argMatch[3];
      const value = argMatch[2] || argMatch[4];
      inputs[key] = value;
    }

    return { workflowId, inputs };
  }

  return null;
}

/**
 * 处理工作流触发
 */
export async function handleWorkflowTrigger(userId: string, message: string): Promise<boolean> {
  await initWorkflowEngine();
  
  const trigger = detectWorkflowTrigger(message);
  if (!trigger) return false;

  try {
    const runId = await workflowEngine.startWorkflow(
      trigger.workflowId,
      trigger.inputs,
      userId,
    );

    // 通知用户工作流已启动
    await sendText({ userId, chatType: 'p2p', sessionId: '' }, `🚀 工作流 **${trigger.workflowId}** 已启动\n运行 ID: \`${runId}\`\n\n我会在各步骤完成时通知你进展。`);
    
    return true;
  } catch (e) {
    await sendText({ userId, chatType: 'p2p', sessionId: '' }, `❌ 启动工作流失败: ${e}`);
    return true;
  }
}
