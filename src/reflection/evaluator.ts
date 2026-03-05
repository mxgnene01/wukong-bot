import { getAgent } from '../agent';
import { logger } from '../utils/logger';

export interface TaskResult {
  taskId: string;
  taskContent: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export interface EvaluationResult {
  score: number; // 0.0 - 1.0
  critique: string;
  success: boolean;
  // 新增：合并 insight 和 action 到评估结果中，避免多轮 LLM 调用
  insight?: string;
  actionType?: 'create_skill' | 'update_memory' | 'none';
  actionDetail?: string;
}

export class TaskEvaluator {
  private agent = getAgent();

  async evaluate(taskResult: TaskResult): Promise<EvaluationResult> {
    logger.info(`[Evaluator] Evaluating task: ${taskResult.taskId}`);

    // Level 1: Deterministic Check — 执行层面失败，直接判定
    if (!taskResult.success) {
      logger.info(`[Evaluator] Task failed technically. Skipping LLM evaluation.`);
      return {
        score: 0.0,
        critique: `Task execution failed: ${taskResult.error || 'Unknown error'}`,
        success: false,
        insight: `Task "${taskResult.taskContent.slice(0, 80)}" failed with error.`,
        actionType: 'none',
      };
    }

    // Level 2: Tool-assisted Deterministic Checks
    // 2.1 JSON 格式验证
    if (taskResult.output.trim().startsWith('{') || taskResult.output.trim().startsWith('[')) {
      try {
        JSON.parse(taskResult.output);
      } catch (e) {
        const jsonMatch = taskResult.output.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) {
          try { JSON.parse(jsonMatch[0]); } catch (e2) {
            return { score: 0.2, critique: `Invalid JSON: ${(e2 as Error).message}`, success: false, actionType: 'none' };
          }
        } else {
          return { score: 0.1, critique: "Malformed JSON output.", success: false, actionType: 'none' };
        }
      }
    }

    // 2.2 文件系统验证
    const fileMatch = taskResult.output.match(/(?:File written to|Created|Saved to|Updated):\s+([^\n]+)/i);
    if (fileMatch) {
      const cleanPath = fileMatch[1].trim().replace(/['"`]/g, '').replace(/\.$/, '');
      try {
        const fileExists = await Bun.file(cleanPath).exists();
        if (!fileExists && (!cleanPath.startsWith('/') || cleanPath.includes('workspace'))) {
          return { score: 0.3, critique: `File "${cleanPath}" not found.`, success: false, actionType: 'none' };
        }
        if (fileExists) {
          const size = (await Bun.file(cleanPath).stat()).size;
          if (size === 0) {
            return { score: 0.4, critique: `File "${cleanPath}" is empty.`, success: false, actionType: 'none' };
          }
        }
      } catch (e) { /* 忽略 */ }
    }

    // Level 3: 合并式 LLM 评估（评分 + 洞察 + 行动建议 一步到位）
    // 重构关键：原来需要 Evaluator → Insight → ThinkingClock → SkillGen 共 4 次 LLM 调用
    // 现在合并为 1 次，让 LLM 一次性完成评分、洞察和行动建议
    const prompt = `
You are a strict QA Reviewer AND Metacognitive Engine for an autonomous Feishu bot.
Evaluate the task result, then decide if any system improvement is needed.

## Task
- **Input**: ${taskResult.taskContent}
- **Status**: Success
- **Duration**: ${taskResult.duration}ms
- **Output** (truncated):
\`\`\`
${taskResult.output.slice(0, 1500)}
\`\`\`

## Step 1: Evaluate
Score 0.0~1.0. Consider: correctness, efficiency, safety, completeness.

## Step 2: Reflect (only if score < 0.6 OR score > 0.9)
- score < 0.6: What went wrong? Root cause?
- score > 0.9: What reusable pattern can be extracted?

## Step 3: Recommend Action (only if reflection exists)
- "create_skill": A reusable pattern worth extracting as a skill. Provide: name (kebab-case), description, triggers.
- "update_memory": A preference/fact worth remembering for this user. Provide: the memory text.
- "none": No action needed.

Be VERY conservative with create_skill — only for patterns reusable 3+ times.

## Output (JSON only)
{
  "score": 0.85,
  "critique": "Brief analysis",
  "success": true,
  "insight": "One sentence summary (or null if score 0.6~0.9)",
  "action_type": "none",
  "action_detail": "null or skill spec or memory text"
}
`;

    try {
      const result = await this.agent.execute(prompt, {
        systemPrompt: 'You are a JSON-speaking evaluation engine. Output valid JSON only.',
        isInternalCall: true, // 跳过 SAFETY_PROMPT，节省 ~400 tokens
        streamOutput: false
      });

      if (!result.success) throw new Error(result.error);

      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: typeof parsed.score === 'number' ? parsed.score : 0.5,
          critique: parsed.critique || "No critique.",
          success: typeof parsed.success === 'boolean' ? parsed.success : true,
          insight: parsed.insight || undefined,
          actionType: parsed.action_type || 'none',
          actionDetail: parsed.action_detail || undefined,
        };
      }
      throw new Error("Invalid JSON in evaluation output");
    } catch (error) {
      logger.error(`[Evaluator] Evaluation failed:`, error);
      return {
        score: taskResult.success ? 0.7 : 0.0,
        critique: "Evaluation failed due to internal error.",
        success: taskResult.success,
        actionType: 'none',
      };
    }
  }
}
