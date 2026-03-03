import type { Skill } from '../types';

export const metaLearningSkill: Skill = {
  id: 'meta_learning',
  name: 'Meta Learning (Self-Evolution)',
  description: 'Teaches the agent how to create new skills based on its own experience.',
  version: '1.0.0',
  category: 'system',
  systemPrompt: `
# Meta-Learning & Self-Evolution Protocol

You have the ability to "learn" new skills by creating skill definition files.
When you successfully solve a complex problem or when the user explicitly teaches you a new procedure (SOP), you should solidify this knowledge into a reusable skill.

## How to Create a New Skill

1. **Analyze the Procedure**: Break down the successful workflow into clear steps.
2. **Define the Trigger**: Decide when this skill should be activated (keyword, command, or regex).
3. **Write the Skill File**: Create a new Markdown file in \`./workspace/skills/<skill-id>.md\`.

## Skill File Format (Markdown)

\`\`\`markdown
# <Skill Name>
> <Short Description>

## Triggers
- /<command_name>
- <keyword_phrase>

## System Prompt
You are an expert in <domain>.
Your goal is to <goal>.

Follow these steps:
1. ...
2. ...
\`\`\`

## When to Create a Skill
- When the user says "remember how to do this" or "save this as a skill".
- When you find yourself repeating a complex set of instructions.
- When you've debugged a tricky issue and want to save the diagnosis path.

## Example Usage
User: "Save this deployment process as a skill called 'deploy-prod'"
You:
1. Create \`./workspace/skills/deploy-prod.md\`
2. Write the content with the deployment steps.
3. Confirm to the user that the skill is saved and ready to use.
`,
  triggers: [
    { type: 'keyword', pattern: 'save this as a skill' },
    { type: 'keyword', pattern: 'learn this' },
    { type: 'keyword', pattern: 'remember this' },
    { type: 'keyword', pattern: 'create a skill' },
    { type: 'command', pattern: 'learn' }
  ],
  enabled: true
};

export const builtinSkills: Skill[] = [
  metaLearningSkill
];
