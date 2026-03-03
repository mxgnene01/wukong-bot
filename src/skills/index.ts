import { getSkillRegistry } from './registry';
import { builtinSkills } from './builtins';
import type { Skill, SkillMatch } from './types';

export * from './types';
export { getSkillRegistry } from './registry';

export function initSkills() {
  const registry = getSkillRegistry();

  for (const skill of builtinSkills) {
    registry.register(skill);
  }

  console.log(`Loaded ${builtinSkills.length} built-in skills`);
}

export function matchSkills(input: string): SkillMatch[] {
  const registry = getSkillRegistry();
  return registry.match(input);
}

export function getBestSkill(input: string): Skill | null {
  const matches = matchSkills(input);
  if (matches.length === 0) return null;
  return matches[0].skill;
}

export function buildSkillPrompt(input: string): string | null {
  const skill = getBestSkill(input);
  if (!skill) return null;
  return skill.systemPrompt;
}
