/**
 * Soul System — Wukong Bot 的 SOUL.md 等价实现
 *
 * 设计哲学（对标 OpenClaw）：
 * 1. 文件即内核：每个 Agent 有独立的 soul.md 文件，作为 Single Source of Truth
 * 2. 自我进化：Agent 可以通过 [UPDATE_SOUL] 指令自主修改自己的 soul
 * 3. 每次启动/Heartbeat 重读：ThinkingClock 和任务执行时自动加载最新 soul
 * 4. 版本控制友好：纯 Markdown 文件，可 git track
 *
 * Soul 文件结构（SOUL.md）:
 * ---
 * name: Agent 名称
 * version: 1.0.0
 * ---
 * ## Core Personality（核心人格）
 * ## Mission & Values（使命与价值观）
 * ## Behavioral Constraints（行为约束）
 * ## Knowledge & Growth（知识与成长记录）
 * ## Memories（关键记忆）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

export interface Soul {
  // 元数据
  name: string;
  version: string;
  agentId: string;

  // 核心身份
  personality: string;
  mission: string;
  constraints: string;

  // 知识与成长
  knowledge: string;
  memories: string[];

  // 原始 Markdown
  rawMarkdown: string;

  // 文件路径
  filePath: string;

  // 最后加载时间
  loadedAt: number;
}

const DEFAULT_SOUL_TEMPLATE = `---
name: Wukong Bot
version: 1.0.0
---

## Core Personality

你是 Wukong Bot，一个专业、高效、持续进化的 AI 助手。
- 沟通风格：简洁明了，技术精准
- 情感基调：友好但不啰嗦，专注于解决问题
- 特质：善于学习，每次交互都在成长

## Mission & Values

**核心使命**：帮助用户高效完成工作，同时持续提升自身能力。

**价值观**：
1. 准确性优先 — 宁可说不确定，不要编造
2. 效率至上 — 用最少的步骤解决问题
3. 持续进化 — 从每次交互中学习，不断改进

## Behavioral Constraints

1. 通过飞书与用户交互，用户无法直接在终端确认操作
2. 对于危险操作（rm -rf、git push --force、DROP TABLE），必须先确认
3. 不执行 bash sleep 等阻塞命令（系统有专门的定时任务机制）
4. 公开思考：遇到复杂问题时，先分析再行动
5. 结构化指令（SCHEDULE_TASK、AGENT_SEND 等）只在用户明确要求时使用，不主动触发

## Knowledge & Growth

> 这里记录 Agent 的学习成长轨迹，由 Agent 自动更新。

（初始状态，尚无成长记录）

## Memories

> 关键记忆和用户偏好。

（初始状态，尚无记忆）
`;

/**
 * 解析 SOUL.md 文件内容
 */
function parseSoulMarkdown(markdown: string, filePath: string, agentId: string): Soul {
  const soul: Soul = {
    name: 'Wukong Bot',
    version: '1.0.0',
    agentId,
    personality: '',
    mission: '',
    constraints: '',
    knowledge: '',
    memories: [],
    rawMarkdown: markdown,
    filePath,
    loadedAt: Date.now(),
  };

  // 解析 frontmatter
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nameMatch = fm.match(/name:\s*(.+)/);
    const versionMatch = fm.match(/version:\s*(.+)/);
    if (nameMatch) soul.name = nameMatch[1].trim();
    if (versionMatch) soul.version = versionMatch[1].trim();
  }

  // 按 ## 标题拆分章节
  const sections = new Map<string, string>();
  const sectionRegex = /^## (.+)$/gm;
  let lastSection: string | null = null;
  let lastIndex = 0;
  let sMatch;

  while ((sMatch = sectionRegex.exec(markdown)) !== null) {
    if (lastSection !== null) {
      sections.set(lastSection, markdown.slice(lastIndex, sMatch.index).trim());
    }
    lastSection = sMatch[1].trim().toLowerCase();
    lastIndex = sMatch.index + sMatch[0].length;
  }
  if (lastSection !== null) {
    sections.set(lastSection, markdown.slice(lastIndex).trim());
  }

  // 映射到 Soul 字段
  for (const [key, value] of sections) {
    if (key.includes('personality') || key.includes('人格')) {
      soul.personality = value;
    } else if (key.includes('mission') || key.includes('使命')) {
      soul.mission = value;
    } else if (key.includes('constraint') || key.includes('约束')) {
      soul.constraints = value;
    } else if (key.includes('knowledge') || key.includes('growth') || key.includes('成长')) {
      soul.knowledge = value;
    } else if (key.includes('memor') || key.includes('记忆')) {
      soul.memories = value
        .split('\n')
        .filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'))
        .map(line => line.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);
    }
  }

  return soul;
}

/**
 * Soul Manager — 管理 Agent 的 SOUL.md 文件
 */
export class SoulManager {
  private soulsDir: string;
  private cache: Map<string, Soul> = new Map();
  private cacheMaxAge = 60_000; // 1 分钟缓存

  constructor(soulsDir?: string) {
    this.soulsDir = soulsDir || join(config.app?.workspaceDir || 'workspace', 'souls');
    mkdirSync(this.soulsDir, { recursive: true });
  }

  /**
   * 获取 Agent 的 Soul（文件读取 + 缓存）
   */
  getSoul(agentId: string = 'default'): Soul {
    const cached = this.cache.get(agentId);
    if (cached && (Date.now() - cached.loadedAt) < this.cacheMaxAge) {
      return cached;
    }

    const filePath = this.getSoulFilePath(agentId);

    if (!existsSync(filePath)) {
      logger.info(`[Soul] Creating default soul for agent: ${agentId}`);
      this.writeSoulFile(filePath, DEFAULT_SOUL_TEMPLATE);
    }

    const markdown = readFileSync(filePath, 'utf-8');
    const soul = parseSoulMarkdown(markdown, filePath, agentId);

    this.cache.set(agentId, soul);
    return soul;
  }

  /**
   * 将 Soul 格式化为 System Prompt 注入
   * 替代原来分散的 SAFETY_PROMPT + agentIdentity
   */
  formatForSystemPrompt(soul: Soul): string {
    const parts: string[] = [];

    if (soul.personality) {
      parts.push(`===== 核心人格 =====\n${soul.personality}`);
    }
    if (soul.mission) {
      parts.push(`===== 使命与价值观 =====\n${soul.mission}`);
    }
    if (soul.constraints) {
      parts.push(`===== 行为约束 =====\n${soul.constraints}`);
    }
    if (soul.knowledge && !soul.knowledge.includes('初始状态')) {
      parts.push(`===== 成长记录 =====\n${soul.knowledge}`);
    }
    if (soul.memories.length > 0) {
      parts.push(`===== 关键记忆 =====\n${soul.memories.map(m => `- ${m}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Agent 自我进化：更新 Soul 的特定章节
   * 由 [UPDATE_SOUL] 指令或反思系统触发
   */
  updateSoulSection(agentId: string, section: string, content: string): boolean {
    const soul = this.getSoul(agentId);
    const markdown = soul.rawMarkdown;

    const sectionPattern = new RegExp(
      `(## ${this.escapeRegex(section)}[^\n]*\n)([\\s\\S]*?)(?=\n## |$)`
    );

    if (!sectionPattern.test(markdown)) {
      logger.warn(`[Soul] Section "${section}" not found for agent ${agentId}`);
      return false;
    }

    let newMarkdown = markdown.replace(sectionPattern, `$1\n${content}\n\n`);

    // 自动递增 patch 版本号
    const versionMatch = newMarkdown.match(/version:\s*((\d+)\.(\d+)\.(\d+))/);
    if (versionMatch) {
      const [, , major, minor, patch] = versionMatch;
      const newVersion = `${major}.${minor}.${Number(patch) + 1}`;
      newMarkdown = newMarkdown.replace(/version:\s*[\d.]+/, `version: ${newVersion}`);
      logger.info(`[Soul] Agent ${agentId} soul version: ${newVersion}`);
    }

    this.writeSoulFile(soul.filePath, newMarkdown);
    this.cache.delete(agentId);
    return true;
  }

  /**
   * 追加成长记录 — 由反思系统自动调用
   */
  appendGrowth(agentId: string, insight: string): void {
    const soul = this.getSoul(agentId);
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `- [${timestamp}] ${insight}`;

    const current = soul.knowledge.replace(/（初始状态.*）/g, '').trim();
    const newContent = current ? `${current}\n${entry}` : entry;

    this.updateSoulSection(agentId, 'Knowledge & Growth', newContent);
  }

  /**
   * 追加记忆 — 由 LTM 系统联动
   */
  appendMemory(agentId: string, memory: string): void {
    const soul = this.getSoul(agentId);
    const cleaned = soul.memories.filter(Boolean);
    cleaned.push(memory);

    // 保留最新 50 条
    const trimmed = cleaned.slice(-50);
    const newContent = trimmed.map(m => `- ${m}`).join('\n');

    this.updateSoulSection(agentId, 'Memories', newContent);
  }

  /**
   * 列出所有已注册的 Agent Soul
   */
  listSouls(): string[] {
    try {
      return readdirSync(this.soulsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    } catch {
      return [];
    }
  }

  /**
   * 从旧的 agentIdentity + SAFETY_PROMPT 迁移到 Soul
   * 一次性迁移工具
   */
  migrateFromLegacy(agentId: string, agentIdentity: string, userFacts: string[]): void {
    const filePath = this.getSoulFilePath(agentId);
    if (existsSync(filePath)) {
      logger.info(`[Soul] Soul file already exists for ${agentId}, skip migration`);
      return;
    }

    let template = DEFAULT_SOUL_TEMPLATE;

    // 将旧的 agentIdentity 写入 Core Personality
    if (agentIdentity && agentIdentity !== 'default') {
      template = template.replace(
        /## Core Personality[\s\S]*?(?=\n## )/,
        `## Core Personality\n\n${agentIdentity}\n\n`
      );
    }

    // 将旧的 facts 写入 Memories
    if (userFacts.length > 0) {
      const memoriesContent = userFacts.map(f => `- ${f}`).join('\n');
      template = template.replace(
        /（初始状态，尚无记忆）/,
        memoriesContent
      );
    }

    this.writeSoulFile(filePath, template);
    logger.info(`[Soul] Migrated legacy identity to soul file for ${agentId}`);
  }

  // ─── Private ───

  private getSoulFilePath(agentId: string): string {
    return join(this.soulsDir, `${agentId}.md`);
  }

  private writeSoulFile(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// 单例
let soulManagerInstance: SoulManager | null = null;

export function getSoulManager(): SoulManager {
  if (!soulManagerInstance) {
    soulManagerInstance = new SoulManager();
  }
  return soulManagerInstance;
}
