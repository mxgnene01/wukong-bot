import { getAgent } from '../agent';
import { logger } from '../utils/logger';
import { getSkillLoader } from '../skills/loader';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { Skill } from '../skills/types';
import { getSkillRegistry } from '../skills/registry';

export interface SkillSpec {
  name: string;
  description: string;
  triggers: string[];
  type: 'script' | 'prompt';
  scriptContent?: string;
  systemPrompt?: string;
  schedule?: string; // cron expression for scheduled skills
}

/**
 * 技能安装来源
 */
export interface MarketSkillInfo {
  id: string;
  name: string;
  description: string;
  author?: string;
  downloadUrl?: string;
  content?: string; // SKILL.md 内容
}

export class SkillManager {
  private agent = getAgent();
  private loader = getSkillLoader();

  /**
   * Step 1: 搜索本地已注册技能
   */
  async findLocalSkill(query: string): Promise<Skill | null> {
    logger.info(`[SkillManager] Searching local skills for: ${query}`);

    const registry = getSkillRegistry();
    const matches = registry.match(query);
    if (matches && matches.length > 0) {
      logger.info(`[SkillManager] Found local skill: ${matches[0].skill.name} (confidence: ${matches[0].confidence.toFixed(2)})`);
      return matches[0].skill;
    }

    // 也按 ID 和名称模糊搜索
    const allSkills = registry.list();
    const lowerQuery = query.toLowerCase();
    for (const skill of allSkills) {
      if (
        skill.id.toLowerCase().includes(lowerQuery) ||
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery)
      ) {
        logger.info(`[SkillManager] Found local skill by name/desc match: ${skill.name}`);
        return skill;
      }
    }

    logger.info(`[SkillManager] No local skill found for: ${query}`);
    return null;
  }

  /**
   * Step 1 (compat): 旧接口兼容
   */
  async findSkill(query: string): Promise<string | null> {
    const skill = await this.findLocalSkill(query);
    return skill ? skill.name : null;
  }
  /**
   * Step 2: 搜索外部技能市场（bytedance-find-skills）
   * 
   * 目前实现为 CLI 调用 Agent 代理搜索；
   * 未来可直接对接 bytedance-find-skills HTTP API。
   */
  async searchMarket(query: string): Promise<MarketSkillInfo | null> {
    logger.info(`[SkillManager] Searching skill market for: ${query}`);

    try {
      // 使用 Agent（Claude CLI）执行市场搜索
      const searchPrompt = `You are a skill marketplace search agent.

Search for a reusable skill/tool that matches this description: "${query}"

If you find a matching skill, output JSON with:
{
  "found": true,
  "skill": {
    "id": "skill-id",
    "name": "Skill Name",
    "description": "What this skill does",
    "content": "Full SKILL.md content that can be saved directly"
  }
}

If no suitable skill exists, output:
{ "found": false, "reason": "Brief explanation" }

IMPORTANT: Output ONLY valid JSON, nothing else.
Use the Bash tool to run: find /Users/bytedance/.claude/ -name "*.md" -path "*/commands/*" 2>/dev/null | head -20
to check if there are any existing command templates that match.
Also check workspace/skills/ for any similar existing skills.`;

      const result = await this.agent.execute(searchPrompt, {
        systemPrompt: 'You are a skill marketplace agent. Search for existing skills and output JSON.',
        isInternalCall: true,
        streamOutput: false,
        timeout: 30000, // 30 秒超时
      });

      if (result.success) {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.found && parsed.skill) {
            logger.info(`[SkillManager] Market search found: ${parsed.skill.name}`);
            return {
              id: parsed.skill.id,
              name: parsed.skill.name,
              description: parsed.skill.description,
              content: parsed.skill.content,
            };
          } else {
            logger.info(`[SkillManager] Market search: no match. Reason: ${parsed.reason || 'unknown'}`);
          }
        }
      }
    } catch (e) {
      logger.error('[SkillManager] Market search failed:', e);
    }

    return null;
  }

  /**
   * Step 2b: 从市场安装技能到本地
   */
  async installFromMarket(marketSkill: MarketSkillInfo): Promise<boolean> {
    logger.info(`[SkillManager] Installing market skill: ${marketSkill.name}`);

    if (!marketSkill.content) {
      logger.warn(`[SkillManager] Market skill ${marketSkill.name} has no content to install`);
      return false;
    }

    const skillDir = `workspace/skills/${marketSkill.id}`;
    const skillFile = `${skillDir}/SKILL.md`;

    try {
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }

      writeFileSync(skillFile, marketSkill.content, 'utf-8');
      logger.info(`[SkillManager] ✅ Market skill installed at ${skillFile}`);

      // SkillLoader 的 file watcher 会自动发现新文件并注册
      return true;
    } catch (e) {
      logger.error('[SkillManager] Failed to install market skill:', e);
      return false;
    }
  }
  /**
   * Step 3: 通过 LLM 创建全新技能（写入 SKILL.md）
   */
  async createSkill(spec: SkillSpec): Promise<boolean> {
    logger.info(`[SkillManager] Creating new skill: ${spec.name}`);

    const skillDir = `workspace/skills/${spec.name}`;
    const skillFile = `${skillDir}/SKILL.md`;

    try {
      // 1. Create Directory
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }

      // 2. Build SKILL.md content
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

      // 3. Write file
      await Bun.write(skillFile, content);

      logger.info(`[SkillManager] ✅ Skill created at ${skillFile}`);

      // 4. SkillLoader's file watcher will auto-detect and register
      return true;
    } catch (e) {
      logger.error('[SkillManager] Failed to create skill:', e);
      return false;
    }
  }

  /**
   * 列出所有已注册技能（供用户查询）
   */
  listSkills(): Skill[] {
    const registry = getSkillRegistry();
    return registry.list();
  }
}