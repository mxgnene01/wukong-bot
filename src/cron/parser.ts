import { getAgent } from '../agent';

export interface ParsedSchedule {
  cron: string;
  description: string;
  content: string;
}

export async function parseNaturalLanguageSchedule(input: string): Promise<ParsedSchedule | null> {
  const match = input.match(/^定时\s*(.+?)\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const [, timeDesc, content] = match;

  const agent = getAgent();
  const prompt = `
将以下自然语言时间描述转换成 cron 表达式。

时间描述：${timeDesc}

请只输出 cron 表达式，不要其他内容。

常见例子：
- "每天早上10点" → "0 10 * * *"
- "每个工作日9点" → "0 9 * * 1-5"
- "每周一早上8点半" → "30 8 * * 1"
- "每小时" → "0 * * * *"
`;

  const result = await agent.execute(prompt, { skipPermissions: true });

  if (!result.success) {
    return null;
  }

  const cron = result.output.trim();

  return {
    cron,
    description: timeDesc,
    content: content.trim(),
  };
}

export function isScheduleCommand(input: string): boolean {
  return /^定时\s*/i.test(input);
}
