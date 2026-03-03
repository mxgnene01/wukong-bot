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

main();
