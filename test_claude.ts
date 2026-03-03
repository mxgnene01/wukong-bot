import { spawn } from 'bun';

console.log('=== Testing Claude Code CLI ===');

const testPrompt = '你好，请介绍一下自己';

// 测试 1: --print 模式
console.log('\n--- Test 1: --print mode ---');
const printProcess = spawn({
  cmd: ['/Users/bytedance/.nvm/versions/node/v22.22.0/bin/claude', '--print', testPrompt],
  cwd: './workspace/playground',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, NO_COLOR: '1' },
});

const printStdout: Buffer[] = [];
const printStderr: Buffer[] = [];

if (printProcess.stdout) {
  for await (const chunk of printProcess.stdout) {
    printStdout.push(chunk);
  }
}
if (printProcess.stderr) {
  for await (const chunk of printProcess.stderr) {
    printStderr.push(chunk);
  }
}

const printExitCode = await printProcess.exited;
console.log('Exit code:', printExitCode);
console.log('Stdout:', Buffer.concat(printStdout).toString('utf-8'));
console.log('Stderr:', Buffer.concat(printStderr).toString('utf-8'));
