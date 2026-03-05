import { SkillManager, type SkillSpec, type MarketSkillInfo } from './skill-manager';
import { getAgent } from '../agent';
import { logger } from '../utils/logger';
import type { Skill } from '../skills/types';

/**
 * 技能进化结果
 */
export interface EvolutionResult {
  success: boolean;
  action: 'found_local' | 'installed_market' | 'created_new' | 'failed';
  skillName?: string;
  skill?: Skill;
  message: string;
}

export class EvolutionEngine {
  private manager = new SkillManager();
  private agent = getAgent();

  /**
   * 完整的三级技能获取链路：
   * 
   * Step 1: 查找本地 → 有则直接使用
   * Step 2: 搜索技能市场 → 有则安装并使用
   * Step 3: LLM 生成并创建 → 自主学习
   * 
   * @param query - 技能描述或名称
   * @param spec  - 可选的预定义 SkillSpec
   */
  async acquireCapability(
    query: string,
    spec?: Partial<SkillSpec>
  ): Promise<EvolutionResult> {
    logger.info(`[Evolution] ═══ Acquiring capability: "${query}" ═══`);

    // ──── Step 1: 查找本地已有技能 ────
    const localSkill = await this.manager.findLocalSkill(query);
    if (localSkill) {
      logger.info(`[Evolution] ✅ Step 1: Found local skill "${localSkill.name}"`);
      return {
        success: true,
        action: 'found_local',
        skillName: localSkill.name,
        skill: localSkill,
        message: `已有技能「${localSkill.name}」可以处理此任务。`,
      };
    }
    logger.info(`[Evolution] Step 1: No local skill found, proceeding to market search...`);

    // ──── Step 2: 搜索外部技能市场 ────
    try {
      const marketSkill = await this.manager.searchMarket(query);
      if (marketSkill) {
        const installed = await this.manager.installFromMarket(marketSkill);
        if (installed) {
          logger.info(`[Evolution] ✅ Step 2: Installed market skill "${marketSkill.name}"`);
          return {
            success: true,
            action: 'installed_market',
            skillName: marketSkill.name,
            message: `从技能市场安装了「${marketSkill.name}」: ${marketSkill.description}`,
          };
        }
      }
    } catch (e) {
      logger.warn(`[Evolution] Step 2: Market search failed, proceeding to create...`, e);
    }
    logger.info(`[Evolution] Step 2: No market skill found, proceeding to LLM generation...`);

    // ──── Step 3: LLM 生成 + 创建新技能 ────
    // 如果提供了预定义 spec，直接使用
    if (spec && spec.name && spec.description) {
      logger.info(`[Evolution] Step 3: Creating from provided spec: ${spec.name}`);
      const created = await this.manager.createSkill(spec as SkillSpec);
      if (created) {
        return {
          success: true,
          action: 'created_new',
          skillName: spec.name,
          message: `已创建新技能「${spec.name}」: ${spec.description}`,
        };
      }
    }

    // 否则用 LLM 生成 SkillSpec
    const generated = await this.generateSkillSpec(query);
    if (generated) {
      const created = await this.manager.createSkill(generated);
      if (created) {
        logger.info(`[Evolution] ✅ Step 3: Created new skill "${generated.name}"`);
        return {
          success: true,
          action: 'created_new',
          skillName: generated.name,
          message: `已学会新技能「${generated.name}」: ${generated.description}\n触发方式: ${generated.triggers.join(', ')}`,
        };
      }
    }

    logger.warn(`[Evolution] ✗ All 3 steps failed for "${query}"`);
    return {
      success: false,
      action: 'failed',
      message: `未能获取「${query}」相关技能。本地无匹配、市场未找到、自动创建失败。`,
    };
  }
  /**
   * 查询已有技能列表（供用户在聊天中查看）
   */
  listSkills(): string {
    const skills = this.manager.listSkills();
    if (skills.length === 0) {
      return '当前没有已注册的技能。';
    }

    const lines = ['📚 **已注册技能列表**：\n'];
    for (const skill of skills) {
      const triggers = skill.triggers
        .map(t => t.type === 'command' ? `/${t.pattern}` : t.pattern)
        .slice(0, 3)
        .join(', ');
      lines.push(`- **${skill.name}** (${skill.id}): ${skill.description || '无描述'}`);
      lines.push(`  触发: ${triggers}`);
    }
    return lines.join('\n');
  }

  /**
   * 从 Reflection 洞察中被动进化（原有逻辑，保持兼容）
   */
  async evolveFromInsight(insight: string): Promise<void> {
    logger.info(`[Evolution] Evolving from insight: ${insight}`);
    const result = await this.acquireCapability(insight);
    if (result.success) {
      logger.info(`[Evolution] Evolved from insight: ${result.message}`);
    }
  }

  /**
   * 使用 LLM 将自然语言描述转换为 SkillSpec
   */
  private async generateSkillSpec(query: string): Promise<SkillSpec | null> {
    const prompt = `
You are a Skill Architect for the Wukong Bot system.
Given the following description, generate a skill specification.

Description: "${query}"

IMPORTANT RULES:
1. skill name must be kebab-case (e.g., "deploy-app", "stock-analysis")
2. triggers should include both command triggers (/skill-name) and keyword triggers
3. type should be "prompt" for knowledge/instruction skills, "script" for executable skills
4. systemPrompt should contain detailed instructions for the AI agent

Output JSON ONLY:
{
  "name": "skill-name",
  "description": "Brief description",
  "triggers": ["/skill-name", "keyword1", "keyword2"],
  "type": "prompt",
  "systemPrompt": "Detailed system prompt instructions..."
}
`;

    try {
      const result = await this.agent.execute(prompt, {
        systemPrompt: 'You are a JSON-speaking skill architect. Output valid JSON only.',
        isInternalCall: true,
        streamOutput: false,
      });

      if (result.success) {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            name: parsed.name,
            description: parsed.description,
            triggers: parsed.triggers || [`/${parsed.name}`],
            type: parsed.type || 'prompt',
            systemPrompt: parsed.systemPrompt || parsed.description,
          };
        }
      }
    } catch (e) {
      logger.error('[Evolution] Failed to generate skill spec:', e);
    }

    return null;
  }
}

let engineInstance: EvolutionEngine | null = null;

export function getEvolutionEngine(): EvolutionEngine {
  if (!engineInstance) {
    engineInstance = new EvolutionEngine();
  }
  return engineInstance;
}