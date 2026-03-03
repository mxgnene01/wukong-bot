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

main();
