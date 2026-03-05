#!/usr/bin/env node
// test_result_structure.mjs — 验证 Claude CLI stream-json 的 result 行结构
import { spawn } from 'child_process';

const proc = spawn('claude', ['-p', 'Reply with just: ok', '--output-format', 'stream-json', '--max-turns', '1'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1' },
});

let buffer = '';

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const json = JSON.parse(line);
      if (json.type === 'result') {
        console.log('=== RESULT MESSAGE ===');
        console.log('Keys:', Object.keys(json).join(', '));
        console.log('Has usage:', !!json.usage);
        console.log('usage type:', typeof json.usage);
        if (json.usage) {
          console.log('usage keys:', Object.keys(json.usage).join(', '));
          console.log('usage.input_tokens:', json.usage.input_tokens);
          console.log('usage.output_tokens:', json.usage.output_tokens);
        }
        console.log('total_cost_usd:', json.total_cost_usd);
        console.log('Has modelUsage:', !!json.modelUsage);
        if (json.modelUsage) {
          console.log('modelUsage keys:', Object.keys(json.modelUsage).join(', '));
        }
        // Print full result (truncated)
        const full = JSON.stringify(json);
        console.log('Full JSON (first 500):', full.slice(0, 500));
      }
    } catch {}
  }
});

proc.stderr.on('data', (chunk) => {
  // ignore stderr
});

proc.on('close', (code) => {
  // Also check buffer remainder
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      if (json.type === 'result') {
        console.log('=== RESULT IN BUFFER REMAINDER ===');
        console.log('Keys:', Object.keys(json).join(', '));
        console.log('Has usage:', !!json.usage);
        if (json.usage) {
          console.log('usage keys:', Object.keys(json.usage).join(', '));
        }
        console.log('total_cost_usd:', json.total_cost_usd);
      }
    } catch {}
  }
  console.log('Exit code:', code);
});

setTimeout(() => { proc.kill('SIGTERM'); process.exit(1); }, 120000);
