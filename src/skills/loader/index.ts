
import { watch, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { logger } from '../../utils/logger';
import { getSkillRegistry } from '../registry';
import type { Skill, SkillTrigger } from '../types';

const SKILLS_DIR = './workspace/skills';

// 确保目录存在
if (!existsSync(SKILLS_DIR)) {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export class SkillLoader {
  private registry = getSkillRegistry();
  private watcher: any;

  start() {
    logger.info('[SkillLoader] Starting skill watcher on', SKILLS_DIR);
    
    // 初始加载
    this.loadAll();

    // 监听变化
    this.watcher = watch(SKILLS_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      
      const filePath = join(SKILLS_DIR, filename);
      
      if (eventType === 'rename' && !existsSync(filePath)) {
        // 文件被删除
        const skillId = basename(filename, '.md');
        this.registry.unregister(skillId);
        logger.info(`[SkillLoader] Unregistered skill: ${skillId}`);
      } else {
        // 文件创建或修改
        this.loadSkill(filePath);
      }
    });
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
    }
  }

  private loadAll() {
    try {
      const files = readdirSync(SKILLS_DIR);
      for (const file of files) {
        if (file.endsWith('.md')) {
          this.loadSkill(join(SKILLS_DIR, file));
        }
      }
    } catch (e) {
      logger.error('[SkillLoader] Failed to load skills:', e);
    }
  }

  private loadSkill(filePath: string) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const skill = this.parseSkill(filePath, content);
      
      if (skill) {
        this.registry.register(skill);
        logger.info(`[SkillLoader] Loaded skill: ${skill.name} (${skill.id})`);
      }
    } catch (e) {
      logger.error(`[SkillLoader] Failed to parse skill ${filePath}:`, e);
    }
  }

  private parseSkill(filePath: string, content: string): Skill | null {
    const filename = basename(filePath);
    const id = basename(filename, '.md');
    
    // 简单的 Markdown 解析
    // 假设格式：
    // # Skill Name
    // > Description
    // 
    // ## Triggers
    // - /command
    // - keyword
    //
    // ## System Prompt
    // ...
    
    const lines = content.split('\n');
    let name = id;
    let description = '';
    let systemPrompt = '';
    const triggers: SkillTrigger[] = [];
    
    let section = '';
    
    for (const line of lines) {
      if (line.startsWith('# ')) {
        name = line.substring(2).trim();
      } else if (line.startsWith('> ') && !description) {
        description = line.substring(2).trim();
      } else if (line.startsWith('## Triggers')) {
        section = 'triggers';
      } else if (line.startsWith('## System Prompt')) {
        section = 'prompt';
      } else if (section === 'triggers' && line.trim().startsWith('- ')) {
        const pattern = line.trim().substring(2).trim();
        if (pattern.startsWith('/')) {
            triggers.push({ type: 'command', pattern: pattern.substring(1) });
        } else {
            triggers.push({ type: 'keyword', pattern });
        }
      } else if (section === 'prompt') {
        if (!line.startsWith('##')) {
          systemPrompt += line + '\n';
        }
      }
    }

    if (!systemPrompt.trim()) return null;

    return {
      id,
      name,
      description,
      version: '1.0.0',
      category: 'user-defined',
      systemPrompt: systemPrompt.trim(),
      triggers,
      enabled: true
    };
  }
}

let loaderInstance: SkillLoader | null = null;

export function getSkillLoader(): SkillLoader {
  if (!loaderInstance) {
    loaderInstance = new SkillLoader();
  }
  return loaderInstance;
}
