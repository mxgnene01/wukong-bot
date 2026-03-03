import { spawn } from 'bun';

console.log('=== Testing Claude Code CLI with JSON output ===');

const testPrompt = '你好，请介绍一下自己';

// 测试: --print --output-format json 模式
console.log('\n--- Test: --print --output-format json ---');
const jsonProcess = spawn({
  cmd: [
    '/Users/bytedance/.nvm/versions/node/v22.22.0/bin/claude',
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    testPrompt
  ],
  cwd: './workspace/playground',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, NO_COLOR: '1' },
});

const jsonStdout: Buffer[] = [];
const jsonStderr: Buffer[] = [];

if (jsonProcess.stdout) {
  for await (const chunk of jsonProcess.stdout) {
    jsonStdout.push(chunk);
  }
}
if (jsonProcess.stderr) {
  for await (const chunk of jsonProcess.stderr) {
    jsonStderr.push(chunk);
  }
}

const jsonExitCode = await jsonProcess.exited;
console.log('Exit code:', jsonExitCode);

const stdoutStr = Buffer.concat(jsonStdout).toString('utf-8');
console.log('Stdout:', stdoutStr);

try {
  const jsonOutput = JSON.parse(stdoutStr);
  console.log('Parsed JSON:', JSON.stringify(jsonOutput, null, 2));
} catch (e) {
  console.log('Failed to parse JSON:', e);
}

console.log('Stderr:', Buffer.concat(jsonStderr).toString('utf-8'));
