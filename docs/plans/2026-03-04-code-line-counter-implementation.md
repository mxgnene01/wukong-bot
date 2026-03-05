# 代码行数统计工具实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 创建一个单文件脚本 `count-lines.ts`，统计 src 目录下 TypeScript 代码的有效行数，支持按目录细分统计。

**Architecture:** 单文件 Bun 脚本，包含文件扫描、分析、聚合和输出格式化功能。

**Tech Stack:** Bun, TypeScript, Node.js fs/path 模块

---

## 前置检查

确认设计文档存在：`docs/plans/2026-03-04-code-line-counter-design.md`

---

## Task 1: 创建脚本文件和基本结构

**Files:**
- Create: `count-lines.ts`

**Step 1: 创建脚本文件**

```typescript
#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

interface FileStats {
  path: string;
  totalLines: number;
  codeLines: number;
  emptyLines: number;
  commentLines: number;
}

interface DirectoryStats {
  name: string;
  fileCount: number;
  totalLines: number;
  codeLines: number;
  emptyLines: number;
  commentLines: number;
}

function main() {
  console.log('='.repeat(70));
  console.log('📊 src 目录代码统计');
  console.log('='.repeat(70));
  console.log('');
  console.log('TODO: Implement statistics');
}

main();
```

**Step 2: 验证文件可执行**

Run: `chmod +x count-lines.ts`
Run: `bun count-lines.ts`
Expected: 输出 TODO 信息

**Step 3: Commit**

```bash
git add count-lines.ts
git commit -m "feat: add code line counter skeleton"
```

---

## Task 2: 实现文件扫描器

**Files:**
- Modify: `count-lines.ts`

**Step 1: 添加文件扫描函数**

在 `interface DirectoryStats` 后添加：

```typescript
function findAllTsFiles(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      findAllTsFiles(filePath, fileList);
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  }

  return fileList;
}
```

**Step 2: 在 main 中测试扫描**

修改 `main()` 函数：

```typescript
function main() {
  const srcDir = join(process.cwd(), 'src');

  console.log('='.repeat(70));
  console.log('📊 src 目录代码统计');
  console.log('='.repeat(70));
  console.log('');

  const tsFiles = findAllTsFiles(srcDir);
  console.log(`Found ${tsFiles.length} .ts files`);
  console.log('');
  for (const file of tsFiles.slice(0, 5)) {
    console.log(`  - ${file}`);
  }
  if (tsFiles.length > 5) {
    console.log(`  ... and ${tsFiles.length - 5} more`);
  }
}
```

**Step 3: 运行测试**

Run: `bun count-lines.ts`
Expected: 显示找到的 .ts 文件列表

**Step 4: Commit**

```bash
git add count-lines.ts
git commit -m "feat: add file scanner"
```

---

## Task 3: 实现文件分析器

**Files:**
- Modify: `count-lines.ts`

**Step 1: 添加行判断辅助函数**

在 `findAllTsFiles` 后添加：

```typescript
function isEmptyLine(line: string): boolean {
  return line.trim().length === 0;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || (trimmed.startsWith('/*') && trimmed.endsWith('*/'));
}

function isCodeLine(line: string): boolean {
  return !isEmptyLine(line) && !isCommentLine(line);
}
```

**Step 2: 添加文件分析函数**

在辅助函数后添加：

```typescript
function analyzeFile(filePath: string): FileStats {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let totalLines = 0;
  let codeLines = 0;
  let emptyLines = 0;
  let commentLines = 0;

  for (const line of lines) {
    totalLines++;
    if (isEmptyLine(line)) {
      emptyLines++;
    } else if (isCommentLine(line)) {
      commentLines++;
    } else {
      codeLines++;
    }
  }

  return {
    path: filePath,
    totalLines,
    codeLines,
    emptyLines,
    commentLines,
  };
}
```

**Step 3: 在 main 中测试分析**

修改 `main()` 函数：

```typescript
function main() {
  const srcDir = join(process.cwd(), 'src');

  console.log('='.repeat(70));
  console.log('📊 src 目录代码统计');
  console.log('='.repeat(70));
  console.log('');

  const tsFiles = findAllTsFiles(srcDir);

  if (tsFiles.length === 0) {
    console.log('❌ 没有找到 .ts 文件');
    process.exit(1);
  }

  console.log('📈 分析文件...');
  const fileStats: FileStats[] = [];

  for (const file of tsFiles) {
    const stats = analyzeFile(file);
    fileStats.push(stats);
  }

  const totalStats = fileStats.reduce(
    (acc, curr) => ({
      totalLines: acc.totalLines + curr.totalLines,
      codeLines: acc.codeLines + curr.codeLines,
      emptyLines: acc.emptyLines + curr.emptyLines,
      commentLines: acc.commentLines + curr.commentLines,
    }),
    { totalLines: 0, codeLines: 0, emptyLines: 0, commentLines: 0 }
  );

  console.log('');
  console.log('📈 总体统计');
  console.log('');
  console.log(`   总文件数: ${tsFiles.length.toLocaleString()}`);
  console.log(`   总行数: ${totalStats.totalLines.toLocaleString()}`);
  console.log(`   有效代码行: ${totalStats.codeLines.toLocaleString()}`);
  console.log(`   空行: ${totalStats.emptyLines.toLocaleString()}`);
  console.log(`   注释行: ${totalStats.commentLines.toLocaleString()}`);
  console.log('');
  console.log('='.repeat(70));
  console.log(`✅ 有效代码行数: ${totalStats.codeLines.toLocaleString()}`);
  console.log('='.repeat(70));
}
```

**Step 4: 运行测试**

Run: `bun count-lines.ts`
Expected: 显示总体统计数据

**Step 5: Commit**

```bash
git add count-lines.ts
git commit -m "feat: add file analyzer"
```

---

## Task 4: 实现目录聚合器

**Files:**
- Modify: `count-lines.ts`

**Step 1: 添加目录聚合逻辑**

在 `analyzeFile` 后添加：

```typescript
function aggregateByDirectory(fileStats: FileStats[]): DirectoryStats[] {
  const dirMap = new Map<string, DirectoryStats>();
  const srcPrefix = join(process.cwd(), 'src') + '/';

  for (const file of fileStats) {
    const relativePath = file.path.replace(srcPrefix, '');
    const parts = relativePath.split('/');
    const dirName = parts.length > 1 ? parts[0] : '(root)';

    if (!dirMap.has(dirName)) {
      dirMap.set(dirName, {
        name: dirName,
        fileCount: 0,
        totalLines: 0,
        codeLines: 0,
        emptyLines: 0,
        commentLines: 0,
      });
    }

    const dirStats = dirMap.get(dirName)!;
    dirStats.fileCount++;
    dirStats.totalLines += file.totalLines;
    dirStats.codeLines += file.codeLines;
    dirStats.emptyLines += file.emptyLines;
    dirStats.commentLines += file.commentLines;
  }

  return Array.from(dirMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
```

**Step 2: 在 main 中添加目录统计输出**

在 `console.log('📈 总体统计');` 前添加：

```typescript
  const dirStats = aggregateByDirectory(fileStats);

  console.log('📂 按目录统计');
  console.log('');
  for (const dir of dirStats) {
    console.log(
      `   ${dir.name.padEnd(15)} ` +
        `文件: ${String(dir.fileCount).padStart(3)}  ` +
        `代码: ${dir.codeLines.toLocaleString().padStart(6)}  ` +
        `总计: ${dir.totalLines.toLocaleString().padStart(6)}`
    );
  }
  console.log('');
```

**Step 3: 运行测试**

Run: `bun count-lines.ts`
Expected: 显示总体统计和按目录统计

**Step 4: Commit**

```bash
git add count-lines.ts
git commit -m "feat: add directory aggregator"
```

---

## Task 5: 最终优化和测试

**Files:**
- Modify: `count-lines.ts`

**Step 1: 运行完整测试**

Run: `bun count-lines.ts`
Expected:
- 显示总体统计（总文件数、总行数、有效代码行、空行、注释行）
- 显示按目录统计（每个目录的文件数、代码行数、总行数）
- 格式美观对齐

**Step 2: 验证统计结果合理性**

手动检查几个文件的行数，确认统计逻辑正确

**Step 3: Commit**

```bash
git add count-lines.ts
git commit -m "feat: finalize code line counter"
```

---

## 完成验证

**Final Test:**
Run: `bun count-lines.ts`
Expected: 完整的统计输出，包含总体统计和按目录统计

---

Plan complete and saved to `docs/plans/2026-03-04-code-line-counter-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
