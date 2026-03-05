import { getAgent } from '../agent';
import { logger } from '../utils/logger';
import { getSkillLoader } from '../skills/loader';
import { existsSync, mkdirSync } from 'fs';
import type { Skill } from '../skills/types';

export interface SkillSpec {
  name: string;
  description: string;
  triggers: string[];
  type: 'script' | 'prompt';
  scriptContent?: string;
  systemPrompt?: string;
  schedule?: string; // cron expression for scheduled skills
}

export class SkillManager {
  private agent = getAgent();
  private loader = getSkillLoader();

  /**
   * Search for existing skills by name/keyword
   */
  async findSkill(query: string): Promise<string | null> {
    logger.info(`[Evolution] Searching for skill: ${query}`);

    // First check local registry
    const registry = this.loader['registry'];
    if (registry) {
      const matches = registry.match(query);
      if (matches && matches.length > 0) {
        logger.info(`[Evolution] Found local skill: ${matches[0].skill.name}`);
        return matches[0].skill.name;
      }
    }

    return null;
  }

  /**
   * Create a new skill as a proper SKILL.md file in workspace/skills/
   * This is the core fix: previously EvolutionEngine never called this method
   */
  async createSkill(spec: SkillSpec): Promise<boolean> {
    logger.info(`[Evolution] Creating new skill: ${spec.name}`);

    const skillDir = `workspace/skills/${spec.name}`;
    const skillFile = `${skillDir}/SKILL.md`;

    try {
      // 1. Create Directory
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }

      // 2. Build SKILL.md content in the correct Wukong Bot format
      const triggersMd = spec.triggers.map(t => `- ${t}`).join('\n');
      const scheduleLine = spec.schedule ? `\n## Schedule\n${spec.schedule}\n` : '';

      const content = `# ${spec.name}
> ${spec.description}

## Triggers
${triggersMd}
${scheduleLine}
## System Prompt
${spec.systemPrompt || spec.description}
`;

      // 3. Write file using Bun.write (fast, atomic)
      await Bun.write(skillFile, content);

      logger.info(`[Evolution] ✅ Skill created at ${skillFile}`);

      // 4. SkillLoader's file watcher will auto-detect and register the new skill
      // No need to manually reload

      return true;
    } catch (e) {
      logger.error('[Evolution] Failed to create skill:', e);
      return false;
    }
  }
}
