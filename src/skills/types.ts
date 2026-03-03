// 参考 deer-flow 的技能系统

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  category?: string;
  systemPrompt: string;
  triggers: SkillTrigger[];
  tools?: string[];
  examples?: SkillExample[];
  enabled: boolean;
}

export interface SkillTrigger {
  type: 'keyword' | 'regex' | 'command' | 'intent';
  pattern: string;
}

export interface SkillExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface SkillMatch {
  skill: Skill;
  trigger: SkillTrigger;
  confidence: number;
}

export interface SkillRegistry {
  register(skill: Skill): void;
  unregister(skillId: string): void;
  get(skillId: string): Skill | undefined;
  list(): Skill[];
  match(input: string): SkillMatch[];
}
