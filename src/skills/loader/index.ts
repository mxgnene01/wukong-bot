
import { watch, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
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

    // 监听变化 (递归监听)
    this.watcher = watch(SKILLS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      
      // 忽略隐藏文件
      if (basename(filename).startsWith('.')) return;

      const filePath = join(SKILLS_DIR, filename);
      
      // 检查文件是否存在
      if (!existsSync(filePath)) {
        // 尝试推断 ID
        // 如果是文件夹下的文件被删，可能需要重新加载整个文件夹作为 Skill
        // 这里简化处理：如果是 .md 文件被删，注销
        if (filename.endsWith('.md')) {
            const skillId = this.getSkillIdFromPath(filename);
            this.registry.unregister(skillId);
            logger.info(`[SkillLoader] Unregistered skill: ${skillId}`);
        }
        return;
      }

      // 如果是目录，忽略（watch 会触发目录下的文件变化）
      if (statSync(filePath).isDirectory()) return;

      // 只处理 .md 文件
      if (!filename.endsWith('.md')) return;

      this.loadSkillFile(filePath);
    });
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
    }
  }

  private loadAll() {
    try {
      this.scanDirectory(SKILLS_DIR);
    } catch (e) {
      logger.error('[SkillLoader] Failed to load skills:', e);
    }
  }

  private scanDirectory(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // 递归扫描子目录
        this.scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        this.loadSkillFile(fullPath);
      }
    }
  }

  private loadSkillFile(filePath: string) {
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

  private getSkillIdFromPath(relativePath: string): string {
    // 策略：
    // 1. 如果在根目录下: coding.md -> coding
    // 2. 如果在子目录下: 
    //    - tdd/SKILL.md -> tdd
    //    - tdd/readme.md -> tdd
    //    - tdd/advanced.md -> tdd-advanced (可选，目前简化为只认 SKILL.md 或 目录名.md)
    
    const parts = relativePath.split('/');
    const filename = parts.pop()!;
    const name = basename(filename, '.md');

    if (parts.length === 0) {
        return name;
    }

    // 在子目录中
    const dirName = parts[parts.length - 1];
    
    // 如果文件名是 SKILL.md 或 README.md，使用目录名作为 ID
    if (name.toUpperCase() === 'SKILL' || name.toUpperCase() === 'README') {
        return dirName;
    }
    
    // 否则使用 目录名-文件名
    return `${dirName}-${name}`;
  }

  private parseSkill(filePath: string, content: string): Skill | null {
    // 计算 ID
    const relativePath = filePath.replace(SKILLS_DIR + '/', '');
    const id = this.getSkillIdFromPath(relativePath);
    
    const lines = content.split('\n');
    let name = id;
    let description = '';
    let systemPrompt = '';
    const triggers: SkillTrigger[] = [];
    
    let section = '';
    let inFrontMatter = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 解析 Front Matter (YAML)
      if (i === 0 && trimmed === '---') {
        inFrontMatter = true;
        continue;
      }
      if (inFrontMatter) {
        if (trimmed === '---') {
          inFrontMatter = false;
          continue;
        }
        const [key, ...values] = trimmed.split(':');
        if (key && values.length > 0) {
            const val = values.join(':').trim();
            if (key === 'name') name = val;
            if (key === 'description') description = val;
        }
        continue;
      }

      // 解析 Markdown Sections
      if (line.startsWith('# ')) {
        // 如果没有在 front matter 定义 name，使用一级标题
        if (name === id) name = line.substring(2).trim();
      } else if (line.startsWith('## Triggers')) {
        section = 'triggers';
      } else if (line.startsWith('## System Prompt') || line.startsWith('## Prompt')) {
        section = 'prompt';
      } else if (section === 'triggers' && trimmed.startsWith('- ')) {
        const pattern = trimmed.substring(2).trim();
        if (pattern.startsWith('/')) {
            triggers.push({ type: 'command', pattern: pattern.substring(1) });
        } else {
            triggers.push({ type: 'keyword', pattern });
        }
      } else {
        // 默认所有其他内容都属于 System Prompt，或者显式在 prompt section 下
        // 简单的启发式：如果还没有进入特定 section，且不是标题，可能是描述
        if (!section && !line.startsWith('#') && !description && trimmed.length > 0) {
            description = trimmed;
        }
        
        // 收集 System Prompt
        // 这里做一个假设：除了元数据外的所有内容都是 prompt 的一部分
        // 或者只收集 ## System Prompt 下的内容
        // 为了兼容旧格式，我们将全文作为 prompt，但移除元数据部分
        if (!inFrontMatter && !line.startsWith('## Triggers')) {
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
