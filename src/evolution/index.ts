import { SkillManager, type SkillSpec } from './skill-manager';
import { getAgent } from '../agent';
import { logger } from '../utils/logger';

export class EvolutionEngine {
  private manager = new SkillManager();
  private agent = getAgent();

  /**
   * Main entry point: Acquire a capability
   * Now actually creates skills when none found (was previously a no-op)
   */
  async acquireCapability(query: string, spec?: Partial<SkillSpec>): Promise<boolean> {
    logger.info(`[Evolution] Acquiring capability: ${query}`);

    // 1. Try to find existing skill
    const found = await this.manager.findSkill(query);
    if (found) {
      logger.info(`[Evolution] Found existing skill for "${query}"`);
      return true;
    }

    // 2. If a spec is provided directly, use it
    if (spec && spec.name && spec.description) {
      logger.info(`[Evolution] Creating skill from provided spec: ${spec.name}`);
      return await this.manager.createSkill(spec as SkillSpec);
    }

    // 3. Otherwise, use LLM to generate a SkillSpec from the query
    logger.info(`[Evolution] No existing skill found. Generating spec via LLM...`);
    const generated = await this.generateSkillSpec(query);
    if (generated) {
      return await this.manager.createSkill(generated);
    }

    logger.warn(`[Evolution] Failed to generate skill spec for "${query}"`);
    return false;
  }

  /**
   * Create a skill from a specific insight (e.g. from Reflection/ThinkingClock)
   */
  async evolveFromInsight(insight: string): Promise<void> {
    logger.info(`[Evolution] Evolving from insight: ${insight}`);
    const spec = await this.generateSkillSpec(insight);
    if (spec) {
      const created = await this.manager.createSkill(spec);
      if (created) {
        logger.info(`[Evolution] Successfully evolved: created skill "${spec.name}"`);
      }
    }
  }

  /**
   * Use LLM to parse a natural language description into a proper SkillSpec
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
        isInternalCall: true, // 跳过 SAFETY_PROMPT，节省 ~400 tokens
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
