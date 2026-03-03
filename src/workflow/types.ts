
/**
 * 工作流定义 — JSON 格式
 * 设计参考 OpenClaw Lobster 工作流引擎
 */
export interface WorkflowDefinition {
  /** 工作流唯一标识 */
  id: string;

  /** 工作流名称 */
  name: string;

  /** 工作流描述 */
  description?: string;

  /** 输入参数定义 */
  inputs?: Record<string, {
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: unknown;
    description?: string;
  }>;

  /** 工作流步骤 */
  steps: WorkflowStep[];

  /** 全局配置 */
  config?: {
    /** 整个工作流的超时（毫秒） */
    timeoutMs?: number;
    /** 失败时是否中止整个工作流 */
    failFast?: boolean;
    /** 最大重试次数（针对整个工作流） */
    maxRetries?: number;
  };
}

export interface WorkflowStep {
  /** 步骤 ID，在工作流内唯一 */
  id: string;

  /** 步骤名称（用于日志和通知） */
  name: string;

  /** 使用哪个 Agent 执行 */
  agentId: string;

  /** 加载哪个 Skill */
  skillId?: string;

  /** 传递给 Agent 的任务描述 */
  task: string;

  /** 依赖的前置步骤 ID */
  dependsOn?: string[];

  /**
   * 执行条件 — JavaScript 表达式
   * 可引用前置步骤的输出：steps.<stepId>.output, steps.<stepId>.status
   * 示例："steps.review.output.approved === true"
   */
  condition?: string;

  /**
   * 输入映射 — 将前置步骤的输出映射到当前步骤的输入
   * 使用模板变量：${steps.<stepId>.output}, ${inputs.<paramName>}
   */
  input?: string;

  /**
   * 循环配置 — 当前步骤重复执行
   * 用于代码→审查→修改 的迭代循环
   */
  loop?: {
    /** 最大迭代次数 */
    maxIterations: number;
    /**
     * 继续条件 — JavaScript 表达式
     * 返回 true 则继续循环，false 则退出
     * 可引用：iteration（当前迭代次数，从1开始）, lastOutput（上次输出）
     */
    continueIf: string;
  };

  /** 步骤超时（毫秒） */
  timeoutMs?: number;

  /** 步骤失败时的处理策略 */
  onFailure?: 'abort' | 'skip' | 'retry';

  /** 重试次数（仅 onFailure = 'retry' 时有效） */
  maxRetries?: number;
}

/**
 * 工作流运行时状态
 */
export interface WorkflowRun {
  /** 运行 ID */
  runId: string;

  /** 工作流定义 ID */
  workflowId: string;

  /** 运行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** 触发者 */
  triggeredBy?: string;

  /** 输入参数 */
  inputs: Record<string, unknown>;

  /** 各步骤的执行结果 */
  steps: Record<string, WorkflowStepResult>;

  /** 创建时间 */
  createdAt: string;

  /** 更新时间 */
  updatedAt: string;

  /** 完成时间 */
  completedAt?: string;

  /** 错误信息 */
  error?: string;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: string;
  structuredOutput?: Record<string, unknown>;
  iteration?: number;  // 当前迭代次数（loop 场景）
  startedAt?: string;
  completedAt?: string;
  error?: string;
  agentSessionKey?: string;
}
