import type { Skill, SkillRegistry, SkillMatch, SkillTrigger } from './types';

export class InMemorySkillRegistry implements SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  unregister(skillId: string): void {
    this.skills.delete(skillId);
  }

  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  list(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }

  match(input: string): SkillMatch[] {
    const matches: SkillMatch[] = [];
    const lowerInput = input.toLowerCase();

    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue;

      for (const trigger of skill.triggers) {
        const result = this.matchTrigger(trigger, lowerInput, input);
        if (result.match) {
          matches.push({
            skill,
            trigger,
            confidence: result.confidence,
          });
        }
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  private matchTrigger(
    trigger: SkillTrigger,
    lowerInput: string,
    originalInput: string
  ): { match: boolean; confidence: number } {
    switch (trigger.type) {
      case 'keyword':
        const hasKeyword = lowerInput.includes(trigger.pattern.toLowerCase());
        return { match: hasKeyword, confidence: hasKeyword ? 0.8 : 0 };

      case 'regex':
        try {
          const regex = new RegExp(trigger.pattern, 'i');
          const match = regex.test(originalInput);
          return { match, confidence: match ? 0.9 : 0 };
        } catch {
          return { match: false, confidence: 0 };
        }

      case 'command':
        const cmdPattern = trigger.pattern.toLowerCase();
        const startsWith = lowerInput.startsWith(cmdPattern) || lowerInput.startsWith('/' + cmdPattern);
        return { match: startsWith, confidence: startsWith ? 1.0 : 0 };

      default:
        return { match: false, confidence: 0 };
    }
  }
}

let registryInstance: InMemorySkillRegistry | null = null;

export function getSkillRegistry(): InMemorySkillRegistry {
  if (!registryInstance) {
    registryInstance = new InMemorySkillRegistry();
  }
  return registryInstance;
}
