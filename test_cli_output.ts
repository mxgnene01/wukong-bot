// test_cli_output.ts - 捕获 claude CLI stream-json 输出格式
import { spawn } from 'child_process';

const proc = spawn('claude', ['-p', 'Say hi in one word', '--output-format', 'stream-json'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let lines: string[] = [];

proc.stdout.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const json = JSON.parse(line);
      lines.push(JSON.stringify({ type: json.type, keys: Object.keys(json) }));
      if (json.type === 'result') {
        console.log('=== RESULT LINE (full) ===');
        console.log(JSON.stringify(json, null, 2));
      }
    } catch {}
  }
});

proc.on('close', (code: number) => {
  console.log('\n=== All message types ===');
  for (const l of lines) console.log(l);
  console.log(`\nExit code: ${code}`);
});

setTimeout(() => { proc.kill(); process.exit(0); }, 60000);
