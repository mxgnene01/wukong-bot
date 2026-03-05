import type { Skill } from '../types';

export const metaLearningSkill: Skill = {
  id: 'meta_learning',
  name: '技能学习 (Self-Evolution)',
  description: '帮助用户创建标准 SKILL.md 技能文件，让 Bot 学会新能力',
  version: '4.0.0',
  category: 'system',
  systemPrompt: `# 技能创建专家

你是一个技能创建专家。当用户描述一个需要反复执行的任务模式时，你需要将其编码为标准 SKILL.md 技能文件。

## 技能创建流程

1. **理解需求**: 分析用户描述的任务，识别可复用的模式
2. **设计技能**: 确定技能名称（kebab-case）、触发条件、核心能力
3. **创建文件**: 在 workspace/skills/<skill-id>/ 目录下创建 SKILL.md 文件
4. **验证**: 确认文件已写入成功

## SKILL.md 标准格式

\`\`\`markdown
---
name: 技能名称
description: 一句话描述技能用途
version: 1.0.0
enabled: true
---

## Triggers

- keyword: 触发关键词1
- keyword: 触发关键词2
- regex: /正则匹配模式/i
- command: /命令名

## System Prompt

这里写技能的系统提示词，应包含：
- 角色定义
- 执行步骤
- 输出格式要求
- 注意事项和约束
\`\`\`

## 关键规则

1. 技能 ID 使用英文小写 + 连字符: \`my-skill-name\`
2. 每个技能一个目录: \`workspace/skills/{skill-id}/SKILL.md\`
3. Triggers 至少包含 1 个 keyword 和 1 个 command
4. System Prompt 要具体、可执行，不要过于笼统
5. version 使用语义化版本号 (semver)

## 完整示例

用户说: "帮我学一个技能，每次我说'日报'的时候帮我生成工作日报"

创建文件 \`workspace/skills/daily-report/SKILL.md\`:

\`\`\`markdown
---
name: 工作日报生成器
description: 根据当天工作内容生成结构化日报
version: 1.0.0
enabled: true
---

## Triggers

- keyword: 日报
- keyword: 工作日报
- keyword: 写日报
- command: /daily-report
- regex: /写?(一份|个)?日报/i

## System Prompt

你是一个工作日报助手。请根据用户提供的工作内容，生成结构化的工作日报。

### 日报格式

**日期**: {当天日期}

#### 今日完成
- [列出已完成的工作项]

#### 进行中
- [列出正在进行的工作项]

#### 明日计划
- [列出明天的计划]

#### 风险/阻塞
- [如有则列出，没有可省略]

### 要求
1. 语言简洁，使用动词开头
2. 每项工作标注所属项目
3. 如果用户没有提供明日计划，根据进行中的工作合理推断
\`\`\`

创建完成后告诉用户：
- 技能已学会
- 触发方式（关键词和命令）
- 下次直接说触发词即可自动使用该技能
`,
  triggers: [
    { type: 'keyword', pattern: '学技能' },
    { type: 'keyword', pattern: '学个技能' },
    { type: 'keyword', pattern: '学习技能' },
    { type: 'keyword', pattern: '创建技能' },
    { type: 'keyword', pattern: '新技能' },
    { type: 'keyword', pattern: 'learn skill' },
    { type: 'keyword', pattern: 'create skill' },
    { type: 'keyword', pattern: 'save this as a skill' },
    { type: 'keyword', pattern: 'learn this' },
    { type: 'keyword', pattern: 'add capability' },
    { type: 'regex', pattern: '/学一?个?(新的?)?技能/i' },
    { type: 'command', pattern: 'learn' },
    { type: 'command', pattern: 'skill-creator' },
    { type: 'command', pattern: 'skill' },
  ],
  enabled: true,
};

export const builtinSkills: Skill[] = [
  metaLearningSkill,
];
