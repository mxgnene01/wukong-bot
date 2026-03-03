
import { v4 as uuid } from 'uuid';
import { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepResult } from './types';
import { getDB } from '../db';
import { makeSessionKey } from '../agent/session';
import { getQueue } from '../queue';
import { EventEmitter } from 'events';

const db = getDB();
const queue = getQueue();

/**
 * 工作流引擎 — 确定性编排器
 *
 * 核心设计原则：
 * 1. 编排逻辑是纯代码，不是 LLM
 * 2. LLM（Claude Code CLI）只负责执行每个步骤的具体任务
 * 3. 步骤间的数据传递通过 Agent Messages + 模板变量
 * 4. 循环/条件/依赖全部由引擎控制
 */
export class WorkflowEngine extends EventEmitter {
  private runs: Map<string, WorkflowRun> = new Map();
  private definitions: Map<string, WorkflowDefinition> = new Map();

  /**
   * 注册工作流定义
   */
  registerWorkflow(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * 从 JSON 文件加载工作流定义
   */
  async loadWorkflowsFromDir(dir: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    try {
      const files = await fs.readdir(dir);

      for (const file of files) {
        if (file.endsWith('.workflow.json')) {
          const content = await fs.readFile(path.join(dir, file), 'utf-8');
          const definition = JSON.parse(content) as WorkflowDefinition;
          this.registerWorkflow(definition);
        }
      }
    } catch (e) {
      console.warn(`[WorkflowEngine] Failed to load workflows from ${dir}:`, e);
    }
  }

  /**
   * 启动工作流
   *
   * @param workflowId 工作流定义 ID
   * @param inputs 输入参数
   * @param triggeredBy 触发来源（用户 ID 或系统）
   * @returns 运行 ID
   */
  async startWorkflow(
    workflowId: string,
    inputs: Record<string, unknown>,
    triggeredBy: string,
  ): Promise<string> {
    const definition = this.definitions.get(workflowId);
    if (!definition) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    // 验证必填参数
    if (definition.inputs) {
      for (const [key, schema] of Object.entries(definition.inputs)) {
        if (schema.required && !(key in inputs)) {
          if (schema.default !== undefined) {
            inputs[key] = schema.default;
          } else {
            throw new Error(`Missing required input: ${key}`);
          }
        }
      }
    }

    // 创建运行实例
    const runId = uuid();
    const run: WorkflowRun = {
      runId,
      workflowId,
      status: 'running',
      triggeredBy,
      inputs,
      steps: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 初始化所有步骤状态
    for (const step of definition.steps) {
      run.steps[step.id] = {
        stepId: step.id,
        status: step.dependsOn?.length ? 'blocked' : 'pending',
      };
    }

    this.runs.set(runId, run);
    this.persistRun(run);

    this.emit('workflow:started', { runId, workflowId, triggeredBy });

    // 开始执行
    // 不要 await，让其在后台运行
    this.executeReadySteps(runId, definition).catch(err => {
      console.error(`[WorkflowEngine] Error executing workflow ${runId}:`, err);
    });

    return runId;
  }

  /**
   * 核心调度循环 — 执行所有就绪的步骤
   *
   * 就绪条件：
   * 1. 状态为 pending
   * 2. 所有 dependsOn 的步骤已 completed
   * 3. condition 条件满足（如果有）
   */
  private async executeReadySteps(runId: string, definition: WorkflowDefinition): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;

    const readySteps = definition.steps.filter(step => {
      const stepResult = run.steps[step.id];
      if (stepResult.status !== 'pending') return false;

      // 检查依赖
      if (step.dependsOn?.length) {
        const allDepsCompleted = step.dependsOn.every(depId => {
          const dep = run.steps[depId];
          return dep && dep.status === 'completed';
        });
        if (!allDepsCompleted) return false;
      }

      // 检查条件
      if (step.condition) {
        try {
          const result = this.evaluateCondition(step.condition, run);
          if (!result) {
            // 条件不满足，跳过
            run.steps[step.id].status = 'skipped';
            run.steps[step.id].completedAt = new Date().toISOString();
            this.emit('step:skipped', { runId, stepId: step.id, reason: 'condition not met' });
            return false;
          }
        } catch (err) {
          // 条件评估失败，视为失败
          run.steps[step.id].status = 'failed';
          run.steps[step.id].error = `Condition evaluation failed: ${err}`;
          return false;
        }
      }

      return true;
    });

    // 并行执行所有就绪步骤
    const execPromises = readySteps.map(step => this.executeStep(runId, definition, step));
    await Promise.allSettled(execPromises);
  }

  /**
   * 执行单个工作流步骤
   */
  private async executeStep(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];

    // 标记为运行中
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    stepResult.agentSessionKey = makeSessionKey(step.agentId, `workflow:${runId}:${step.id}`);

    this.emit('step:started', { runId, stepId: step.id, agentId: step.agentId });

    try {
      // 处理循环
      if (step.loop) {
        await this.executeStepWithLoop(runId, definition, step);
      } else {
        await this.executeStepOnce(runId, definition, step);
      }
    } catch (err) {
      stepResult.status = 'failed';
      stepResult.error = String(err);
      stepResult.completedAt = new Date().toISOString();

      this.emit('step:failed', { runId, stepId: step.id, error: String(err) });

      // 处理失败策略
      if (step.onFailure === 'abort' || definition.config?.failFast) {
        run.status = 'failed';
        run.error = `Step ${step.id} failed: ${err}`;
        this.emit('workflow:failed', { runId, error: run.error });
        return;
      }
    }

    this.persistRun(run);

    // 检查是否所有步骤完成
    this.checkWorkflowCompletion(runId, definition);

    // 触发下游步骤（解除阻塞）
    this.unblockDependentSteps(runId, definition, step.id);

    // 继续执行就绪的步骤
    await this.executeReadySteps(runId, definition);
  }

  /**
   * 执行单次步骤（无循环）
   */
  private async executeStepOnce(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];
    const sessionKey = stepResult.agentSessionKey!;

    // 构造任务输入 — 使用模板变量替换
    const taskMessage = this.resolveTemplate(step.task, run);
    const inputData = step.input ? this.resolveTemplate(step.input, run) : undefined;

    // 创建任务并放入队列
    const correlationId = `workflow:${runId}:${step.id}`;

    // 通过任务队列提交给 Worker
    queue.enqueueTask({
      type: 'message',
      context: {
        chatType: 'p2p', // 虚拟 context
        sessionId: sessionKey,
        userId: run.triggeredBy || 'system',
      },
      content: inputData ? `${taskMessage}\n\n---\n\n## 上下文数据\n\n${inputData}` : taskMessage,
      sessionKey,
      agentId: step.agentId,
      skillId: step.skillId,
      correlationId,
      metadata: {
        workflowId: definition.id,
        runId,
        stepId: step.id,
      },
    });

    // 等待任务完成（通过 Agent Message 回复）
    const reply = await db.waitForReply(
      `workflow:${runId}`,       // 工作流引擎的 session key
      correlationId,
      step.timeoutMs || 300_000, // 默认 5 分钟超时
    );

    if (!reply) {
      throw new Error(`Step ${step.id} timed out`);
    }

    // 记录结果
    stepResult.status = 'completed';
    stepResult.output = reply.message;
    stepResult.completedAt = new Date().toISOString();

    // 尝试解析结构化输出
    try {
      // 提取 JSON 部分
      const jsonMatch = reply.message.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        stepResult.structuredOutput = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // 非 JSON 输出，保持原样
    }

    this.emit('step:completed', { runId, stepId: step.id, output: reply.message });
  }

  /**
   * 带循环的步骤执行
   * 用于代码→审查→修改 的迭代场景
   */
  private async executeStepWithLoop(
    runId: string,
    definition: WorkflowDefinition,
    step: WorkflowStep,
  ): Promise<void> {
    const run = this.runs.get(runId)!;
    const stepResult = run.steps[step.id];
    const loop = step.loop!;

    let lastOutput: string | undefined;

    for (let iteration = 1; iteration <= loop.maxIterations; iteration++) {
      stepResult.iteration = iteration;

      this.emit('step:loop-iteration', { runId, stepId: step.id, iteration, maxIterations: loop.maxIterations });

      // 执行一次
      const sessionKey = makeSessionKey(step.agentId, `workflow:${runId}:${step.id}:iter-${iteration}`);
      stepResult.agentSessionKey = sessionKey;

      const correlationId = `workflow:${runId}:${step.id}:iter-${iteration}`;

      // 构造包含迭代上下文的任务
      const iterationContext = lastOutput
        ? `\n\n## 上一轮结果（第 ${iteration - 1} 轮）\n\n${lastOutput}`
        : '';

      const taskMessage = this.resolveTemplate(step.task, run) + iterationContext;

      queue.enqueueTask({
        type: 'message',
        context: {
            chatType: 'p2p',
            sessionId: sessionKey,
            userId: run.triggeredBy || 'system',
        },
        content: taskMessage,
        sessionKey,
        agentId: step.agentId,
        skillId: step.skillId,
        correlationId,
        metadata: {
          workflowId: definition.id,
          runId,
          stepId: step.id,
          iteration,
        },
      });

      const reply = await db.waitForReply(
        `workflow:${runId}`,
        correlationId,
        step.timeoutMs || 300_000,
      );

      if (!reply) {
        throw new Error(`Step ${step.id} iteration ${iteration} timed out`);
      }

      lastOutput = reply.message;

      // 检查是否继续循环
      const shouldContinue = this.evaluateLoopCondition(loop.continueIf, {
        iteration,
        lastOutput,
        run,
      });

      if (!shouldContinue) {
        break;
      }
    }

    // 记录最终结果
    stepResult.status = 'completed';
    stepResult.output = lastOutput;
    stepResult.completedAt = new Date().toISOString();

    try {
        const jsonMatch = lastOutput?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            stepResult.structuredOutput = JSON.parse(jsonMatch[0]);
        }
    } catch {
      // 非 JSON
    }

    this.emit('step:completed', { runId, stepId: step.id, output: lastOutput, iterations: stepResult.iteration });
  }

  /**
   * 模板变量解析
   * 支持：${inputs.xxx}, ${steps.xxx.output}, ${steps.xxx.status}
   */
  private resolveTemplate(template: string, run: WorkflowRun): string {
    return template.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
      const parts = path.split('.');

      if (parts[0] === 'inputs') {
        return String(run.inputs[parts[1]] ?? match);
      }

      if (parts[0] === 'steps' && parts.length >= 3) {
        const stepId = parts[1];
        const field = parts[2]; // "output" or "status"
        const stepResult = run.steps[stepId];
        if (!stepResult) return match;

        if (field === 'output') {
          if (parts.length > 3 && stepResult.structuredOutput) {
            // 支持 ${steps.review.output.approved} 深度访问
            let obj: unknown = stepResult.structuredOutput;
            for (let i = 3; i < parts.length; i++) {
              obj = (obj as Record<string, unknown>)?.[parts[i]];
            }
            return String(obj ?? match);
          }
          return stepResult.output ?? match;
        }

        if (field === 'status') return stepResult.status;
      }

      return match;
    });
  }

  /**
   * 条件表达式评估
   * 安全地评估简单条件，不使用 eval()
   */
  private evaluateCondition(condition: string, run: WorkflowRun): boolean {
    // 替换变量引用为实际值
    const resolved = this.resolveTemplate(condition, run);

    // 支持简单的比较操作
    // "true" / "false" 直接判断
    if (resolved.trim() === 'true') return true;
    if (resolved.trim() === 'false') return false;

    // "value === expected" 格式
    const eqMatch = resolved.match(/^(.+?)\s*===\s*(.+)$/);
    if (eqMatch) {
      const left = eqMatch[1].trim().replace(/^["']|["']$/g, '');
      const right = eqMatch[2].trim().replace(/^["']|["']$/g, '');
      return left === right;
    }

    // "value !== expected" 格式
    const neqMatch = resolved.match(/^(.+?)\s*!==\s*(.+)$/);
    if (neqMatch) {
      const left = neqMatch[1].trim().replace(/^["']|["']$/g, '');
      const right = neqMatch[2].trim().replace(/^["']|["']$/g, '');
      return left !== right;
    }

    // 默认：非空字符串视为 true
    return resolved.trim().length > 0 && resolved.trim() !== 'undefined' && resolved.trim() !== 'null';
  }

  /**
   * 循环条件评估
   */
  private evaluateLoopCondition(
    condition: string,
    context: { iteration: number; lastOutput: string | undefined; run: WorkflowRun },
  ): boolean {
    let resolved = condition;

    // 替换循环特有变量
    resolved = resolved.replace(/\biteration\b/g, String(context.iteration));
    resolved = resolved.replace(/\blastOutput\.(\w+)\b/g, (_, field: string) => {
      try {
        const jsonMatch = context.lastOutput?.match(/\{[\s\S]*\}/);
        const obj = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
        return String(obj[field] ?? 'undefined');
      } catch {
        return 'undefined';
      }
    });

    return this.evaluateCondition(resolved, context.run);
  }

  /**
   * 解除依赖阻塞 — 当一个步骤完成后，检查并解除下游步骤的阻塞
   */
  private unblockDependentSteps(runId: string, definition: WorkflowDefinition, completedStepId: string): void {
    const run = this.runs.get(runId)!;

    for (const step of definition.steps) {
      if (!step.dependsOn?.includes(completedStepId)) continue;

      const stepResult = run.steps[step.id];
      if (stepResult.status !== 'blocked') continue;

      // 检查所有依赖是否都完成
      const allDepsCompleted = step.dependsOn.every(depId => {
        const dep = run.steps[depId];
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });

      if (allDepsCompleted) {
        stepResult.status = 'pending';
        this.emit('step:unblocked', { runId, stepId: step.id });
      }
    }
  }

  /**
   * 检查工作流是否已全部完成
   */
  private checkWorkflowCompletion(runId: string, definition: WorkflowDefinition): void {
    const run = this.runs.get(runId)!;

    const allDone = definition.steps.every(step => {
      const result = run.steps[step.id];
      return ['completed', 'skipped', 'failed'].includes(result.status);
    });

    if (allDone) {
      const hasFailure = definition.steps.some(step => run.steps[step.id].status === 'failed');
      run.status = hasFailure ? 'failed' : 'completed';
      run.completedAt = new Date().toISOString();

      this.emit('workflow:completed', {
        runId,
        status: run.status,
        steps: run.steps,
      });
    }
  }

  /**
   * 持久化工作流运行状态到数据库
   */
  private persistRun(run: WorkflowRun): void {
    run.updatedAt = new Date().toISOString();
    
    // 这里简单实现：如果需要持久化到 DB，可以在 DB 类中添加方法
    // 目前暂不实现 DB 持久化，仅内存维护
  }

  /**
   * 获取工作流运行状态
   */
  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * 取消工作流
   */
  cancelWorkflow(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();

    // 标记所有运行中/待执行的步骤为取消
    for (const stepResult of Object.values(run.steps)) {
      if (['pending', 'blocked', 'running'].includes(stepResult.status)) {
        stepResult.status = 'skipped';
        stepResult.completedAt = new Date().toISOString();
        stepResult.error = 'Workflow cancelled';
      }
    }

    this.persistRun(run);
    this.emit('workflow:cancelled', { runId });
  }
}
