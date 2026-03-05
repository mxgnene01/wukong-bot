import { getDB } from '../db';
import { TaskEvaluator, type TaskResult, type EvaluationResult } from './evaluator';
import { logger } from '../utils/logger';
import type { Reflection } from '../types';
import { v4 as uuidv4 } from 'uuid';

export interface ReflectionResult {
  reflection: Reflection | null;
  evaluation: EvaluationResult;
}

export class ReflectionEngine {
  private evaluator = new TaskEvaluator();
  private db = getDB();

  /**
   * 合并后的反思流程：
   * 旧流程：Evaluator(LLM) → InsightGenerator(LLM) = 2 次 LLM 调用
   * 新流程：Evaluator(LLM, 合并式) = 1 次 LLM 调用，同时产出 score + insight + action
   */
  async analyze(taskResult: TaskResult): Promise<Reflection | null> {
    // 1. 合并式评估（评分 + 洞察 + 行动建议一步到位）
    const evaluation = await this.evaluator.evaluate(taskResult);
    logger.info(`[Reflection] Task Score: ${evaluation.score}, Action: ${evaluation.actionType || 'none'}`);

    // 2. 如果有 insight，保存反思记录
    if (evaluation.insight) {
      const reflection: Reflection = {
        id: uuidv4(),
        taskId: taskResult.taskId,
        trigger: evaluation.score > 0.9 ? 'success_pattern' : 'failure_analysis',
        content: evaluation.insight,
        actionableItem: this.buildActionableItem(evaluation),
        createdAt: Date.now()
      };

      this.saveReflection(reflection);
      return reflection;
    }

    return null;
  }

  /**
   * 从评估结果构建 actionableItem 字符串
   * 新增 update_memory 支持，不再只关注 "skill"
   */
  private buildActionableItem(evaluation: EvaluationResult): string {
    if (!evaluation.actionType || evaluation.actionType === 'none') return '';

    if (evaluation.actionType === 'create_skill' && evaluation.actionDetail) {
      return `Create skill: ${evaluation.actionDetail}`;
    }

    if (evaluation.actionType === 'update_memory' && evaluation.actionDetail) {
      return `Update memory: ${evaluation.actionDetail}`;
    }

    return '';
  }

  private saveReflection(reflection: Reflection) {
    try {
      const stmt = this.db['db'].prepare(`
        INSERT INTO reflections (id, task_id, trigger, content, actionable_item, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        reflection.id,
        reflection.taskId,
        reflection.trigger,
        reflection.content,
        reflection.actionableItem,
        reflection.createdAt
      );
      logger.info(`[Reflection] Saved: ${reflection.content}`);
    } catch (e) {
      logger.error('[Reflection] Failed to save:', e);
    }
  }
}

let engineInstance: ReflectionEngine | null = null;

export function getReflectionEngine(): ReflectionEngine {
  if (!engineInstance) {
    engineInstance = new ReflectionEngine();
  }
  return engineInstance;
}
