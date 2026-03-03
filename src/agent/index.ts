import { spawn } from 'bun';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { AgentResult, AgentOptions, TokenUsage } from '../types';

// 安全约束提示
const SAFETY_PROMPT = `
你正在通过飞书与用户交互，用户无法直接在终端确认操作。

对于以下危险操作，必须先向用户说明并等待明确确认后再执行：
- rm / rm -rf（删除文件）
- git push --force / git reset --hard
- DROP TABLE / DELETE FROM
`;

export class ClaudeAgent {
  private claudePath: string;
  private workDir: string;

  constructor(claudePath: string = config.claudeCodePath, workDir: string = config.workDir) {
    this.claudePath = claudePath;
    this.workDir = workDir;
  }

  async execute(prompt: string, options: AgentOptions = {}): Promise<AgentResult> {
    const startTime = Date.now();
    const timeout = options.timeout || config.taskTimeout;

    try {
      const args = this.buildArgs(options);
      args.push('--print');
      args.push('--output-format', 'json');
      args.push(prompt);

      logger.info('[Agent] Executing Claude CLI...');
      // 截断 prompt，避免日志过长
      const promptIndex = args.indexOf('--print') + 3; // --print --output-format json <prompt>
      const displayArgs = args.slice();
      if (promptIndex < displayArgs.length && displayArgs[promptIndex].length > 200) {
        displayArgs[promptIndex] = displayArgs[promptIndex].slice(0, 200) + '...[truncated]';
      }
      logger.debug('[Agent] Command:', this.claudePath, displayArgs.join(' '));
      logger.debug('[Agent] Working dir:', this.workDir);

      // 构建环境变量对象，移除 CLAUDECODE 防止嵌套 session 检测
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key !== 'CLAUDECODE' && value !== undefined) {
          env[key] = value;
        }
      }
      env.NO_COLOR = '1';

      const childProcess = spawn({
        cmd: [this.claudePath, ...args],
        cwd: this.workDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Execution timeout')), timeout);
      });

      const outputPromise = this.collectOutput(childProcess);

      const result = await Promise.race([outputPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      logger.info('[Agent] Claude CLI exited with code:', result.exitCode);
      if (result.stdout) {
        logger.debug('[Agent] stdout:', result.stdout.substring(0, 500) + (result.stdout.length > 500 ? '...' : ''));
      }
      if (result.stderr) {
        logger.error('[Agent] stderr:', result.stderr);
      }

      if (result.exitCode !== 0) {
        return {
          success: false,
          output: result.stdout || '',
          error: result.stderr || `Process exited with code ${result.exitCode}`,
          duration,
          sessionId: result.sessionId,
          tokenUsage: result.tokenUsage,
        };
      }

      return {
        success: true,
        output: result.stdout,
        duration,
        sessionId: result.sessionId,
        tokenUsage: result.tokenUsage,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  private buildArgs(options: AgentOptions): string[] {
    const args: string[] = [];

    if (options.systemPrompt) {
      args.push('--append-system-prompt', SAFETY_PROMPT + '\n\n' + options.systemPrompt);
    } else {
      args.push('--append-system-prompt', SAFETY_PROMPT);
    }

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    return args;
  }

  private async collectOutput(process: any): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    sessionId?: string;
    tokenUsage?: TokenUsage;
  }> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let sessionId: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let contentText = '';

    if (process.stdout) {
      for await (const chunk of process.stdout) {
        stdoutChunks.push(chunk);
      }
    }

    if (process.stderr) {
      for await (const chunk of process.stderr) {
        stderrChunks.push(chunk);
      }
    }

    const exitCode = await process.exited;
    const rawOutput = Buffer.concat(stdoutChunks).toString('utf-8');

    // 解析 JSON 输出
    try {
      const jsonOutput = JSON.parse(rawOutput);

      // 提取 session_id
      if (jsonOutput.session_id) {
        sessionId = jsonOutput.session_id;
        logger.info('[Agent] Extracted sessionId from JSON:', sessionId);
      }

      // 提取 token usage
      if (jsonOutput.usage) {
        tokenUsage = {
          inputTokens: jsonOutput.usage.input_tokens || 0,
          outputTokens: jsonOutput.usage.output_tokens || 0,
          cacheCreationInputTokens: jsonOutput.usage.cache_creation_input_tokens,
          cacheReadInputTokens: jsonOutput.usage.cache_read_input_tokens,
          totalCostUsd: jsonOutput.total_cost_usd,
        };
        logger.info('[Agent] Token usage:', tokenUsage);
      }

      // 提取内容
      if (jsonOutput.result) {
        contentText = jsonOutput.result;
      } else if (jsonOutput.content) {
        contentText = jsonOutput.content;
      } else if (jsonOutput.output) {
        contentText = jsonOutput.output;
      } else if (jsonOutput.text) {
        contentText = jsonOutput.text;
      } else {
        // 如果没有明确的 content 字段，返回原始 JSON（用于调试）
        contentText = rawOutput;
      }
    } catch (e) {
      // 如果 JSON 解析失败，回退到原始文本输出
      logger.debug('[Agent] Failed to parse JSON output, using raw text:', e);
      contentText = rawOutput;

      // 仍然尝试从原始文本中提取 session_id
      const sessionMatch = rawOutput.match(/"session_id"\s*:\s*"([^"]+)"/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
      }
    }

    return {
      stdout: contentText,
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      exitCode,
      sessionId,
      tokenUsage,
    };
  }
}

let agentInstance: ClaudeAgent | null = null;

export function getAgent(): ClaudeAgent {
  if (!agentInstance) {
    agentInstance = new ClaudeAgent();
  }
  return agentInstance;
}
