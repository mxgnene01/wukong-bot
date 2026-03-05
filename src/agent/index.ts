import { spawn } from 'bun';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { AgentResult, AgentOptions, TokenUsage } from '../types';

// 安全约束提示 — 仅包含危险操作防护，不包含工具指令
const SAFETY_PROMPT = `
你正在通过飞书与用户交互，用户无法直接在终端确认操作。

对于以下危险操作，必须先向用户说明并等待明确确认后再执行：
- rm / rm -rf（删除文件）
- git push --force / git reset --hard
- DROP TABLE / DELETE FROM
`;

// 系统能力指令 — 单独模块，仅在非简单任务时由 executor 注入
// 避免 Claude 在简单问候时误触发工具指令
export const SYSTEM_CAPABILITIES_PROMPT = `
===== 系统能力：定时提醒 =====
你有定时任务和延时提醒的能力。

⚠️ 重要：只有在用户**明确要求**设置提醒或定时任务时才使用以下指令。
不要在用户没有要求的情况下主动创建定时任务。

当用户要求"X分钟后提醒我..."、"每天X点提醒我..."等定时类需求时：
- 不要使用 bash 的 sleep 命令！这会导致进程挂起。
- 在你的回复文本中嵌入如下结构化指令，系统会自动解析并创建定时任务：

一次性延时提醒（N分钟后）：
[SCHEDULE_TASK delay="N" unit="minutes"]提醒内容[/SCHEDULE_TASK]

周期性定时任务（cron 表达式）：
[SCHEDULE_TASK cron="0 22 * * *"]提醒内容[/SCHEDULE_TASK]

示例：
- 用户说"20分钟后提醒我睡觉" → [SCHEDULE_TASK delay="20" unit="minutes"]⏰ 该睡觉了！[/SCHEDULE_TASK]
- 用户说"每天晚上10点提醒我写日报" → [SCHEDULE_TASK cron="0 22 * * *"]📝 该写日报了！[/SCHEDULE_TASK]

===== 系统能力：自我进化 =====
当你从交互中学到了重要的洞察、掌握了新的能力模式、或发现了可以改进的地方时，
可以在回复中嵌入以下指令来更新你的"灵魂文件"（类似 OpenClaw 的 SOUL.md）：

更新成长记录：
[UPDATE_SOUL section="Knowledge & Growth"]
- [日期] 学到的新洞察或能力
[/UPDATE_SOUL]

更新关键记忆：
[UPDATE_SOUL section="Memories"]
- 用户的重要偏好或习惯
[/UPDATE_SOUL]

注意：只有真正有价值的洞察才值得记录，不要滥用。
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
      args.push('--verbose'); // stream-json 模式需要 verbose
      args.push('--print');
      args.push('--output-format', 'stream-json');
      args.push(prompt);

      logger.info('[Agent] Executing Claude CLI...');
      // 截断 prompt，避免日志过长
      const promptIndex = args.indexOf('--print') + 3; // --print --output-format stream-json <prompt>
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

      // 动态配置 ANTHROPIC_BASE_URL
      // 如果启用了本地代理，则指向代理地址；否则删除该环境变量（使用默认或系统配置）
      if (process.env.ENABLE_LOCAL_PROXY === 'true') {
        const port = process.env.PROXY_PORT || '8080';
        env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
        logger.debug('[Agent] Using local proxy:', env.ANTHROPIC_BASE_URL);
      } else {
        // 显式删除，防止继承了外部环境的配置
        delete env.ANTHROPIC_BASE_URL;
        logger.debug('[Agent] Using default Anthropic API');
      }

      // 添加详细的参数调试日志
      logger.debug('[Agent] CLI Arguments:', JSON.stringify(args));
      
      const childProcess = spawn({
        cmd: [this.claudePath, ...args],
        cwd: this.workDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });

      // 硬超时保护：防止 CLI 进程无限挂起（例如 Claude 执行了 sleep 等长时间命令）
      const hardTimeout = timeout + 30_000; // 给 CLI 额外 30 秒宽限期
      const killTimer = setTimeout(() => {
        logger.warn(`[Agent] Hard timeout reached (${hardTimeout / 1000}s), force killing CLI process`);
        try {
          childProcess.kill();
        } catch (e) {
          logger.error('[Agent] Failed to kill process:', e);
        }
      }, hardTimeout);

      // 监听中止信号
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          logger.warn('[Agent] Abort signal received, killing Claude process...');
          childProcess.kill(); // 默认发送 SIGTERM
        });
      }

      // 监听进程错误事件
      // 注意：Bun.spawn 返回的对象没有 'on' 方法用于监听 'error' 事件
      // 这里的错误捕获主要依赖 try-catch 和 exitCode 判断
      
      // 创建更健壮的流收集器
      const result = await this.collectOutput(childProcess, options);
      clearTimeout(killTimer); // 正常退出，清除硬超时定时器
      const duration = Date.now() - startTime;

      logger.info('[Agent] Claude CLI exited with code:', result.exitCode);
      // stdout 包含大量 JSON Lines，日志记录可能会很长，只记录部分
      if (result.stdout) {
        const lines = result.stdout.split('\n');
        logger.debug(`[Agent] stdout lines: ${lines.length}`);
      }
      if (result.stderr) {
        logger.error('[Agent] stderr:', result.stderr);
      }

      if (result.exitCode !== 0) {
        // 如果失败且指定了 resumeSessionId，尝试不带 resume 重试
        if (options.resumeSessionId) {
            logger.warn(`[Agent] Execution failed with resume session ${options.resumeSessionId}. Retrying without resume...`);
            const retryOptions = { ...options };
            delete retryOptions.resumeSessionId;
            return this.execute(prompt, retryOptions);
        }

        return {
          success: false,
          output: result.resultText || '',
          error: result.stderr || `Process exited with code ${result.exitCode}`,
          duration,
          sessionId: result.sessionId,
          tokenUsage: result.tokenUsage,
        };
      }

      return {
        success: true,
        output: result.resultText, // 使用解析后的最终文本
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

    const isResume = !!options.resumeSessionId;

    if (isResume) {
      // Resume 模式：Claude 已有上一轮完整 system prompt，只注入增量（新技能 + 收件箱）
      // 节省 ~3000-5000 tokens
      args.push('--resume', options.resumeSessionId!);

      if (options.systemPrompt) {
        // systemPrompt 在 resume 时只包含本轮增量部分（由 Executor 控制内容）
        args.push('--append-system-prompt', options.systemPrompt);
      }
    } else if (options.isInternalCall || options.isSimpleTask) {
      // 内部 LLM 调用（Evaluator/Evolution）或简单任务（问候/查询）：跳过 SAFETY_PROMPT
      // 简单任务不涉及危险操作，注入 SAFETY_PROMPT 只会增加噪音
      if (options.systemPrompt) {
        args.push('--append-system-prompt', options.systemPrompt);
      }
    } else {
      // 新会话：完整注入 SAFETY_PROMPT + systemPrompt
      if (options.systemPrompt) {
        args.push('--append-system-prompt', SAFETY_PROMPT + '\n\n' + options.systemPrompt);
      } else {
        args.push('--append-system-prompt', SAFETY_PROMPT);
      }
    }

    // 限制工具调用轮次，防止 Claude 执行 sleep 等长时间命令导致进程无限挂起
    args.push('--max-turns', '3');

    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    return args;
  }

  private async collectOutput(process: any, options: AgentOptions): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    sessionId?: string;
    tokenUsage?: TokenUsage;
    resultText: string;
  }> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let sessionId: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let resultText = '';
    let lastAssistantText = '';  // 兜底：从 assistant 消息中提取的最后一个 text content

    // 用于处理分块 JSON 的缓冲区
    let buffer = '';

    if (process.stdout) {
      for await (const chunk of process.stdout) {
        logger.debug(`[Agent] Received stdout chunk: ${chunk.length} bytes`);
        stdoutChunks.push(chunk);
        
        // 实时解析 JSON Lines
        const text = chunk.toString('utf-8');
        buffer += text;
        
        const lines = buffer.split('\n');
        // 保留最后一个可能不完整的行
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            logger.debug('[Agent] Stream line:', line.slice(0, 200));
            
            const json = JSON.parse(line);
            
            // 1. 提取 Session ID (Claude CLI 输出的字段名是 snake_case: session_id)
            if (json.session_id) {
              sessionId = json.session_id;
            } else if (json.sessionId) {
              sessionId = json.sessionId;
            }
            
            // 2. 提取 Token Usage
            if (json.type === 'result' && json.usage) {
               tokenUsage = {
                inputTokens: json.usage.input_tokens || 0,
                outputTokens: json.usage.output_tokens || 0,
                cacheCreationInputTokens: json.usage.cache_creation_input_tokens,
                cacheReadInputTokens: json.usage.cache_read_input_tokens,
                totalCostUsd: json.total_cost_usd,
              };
            }
            
            // 3. 提取最终结果
            if (json.type === 'result') {
              logger.debug('[Agent] Result JSON keys:', Object.keys(json).join(', '));
              logger.debug('[Agent] Result JSON result field type:', typeof json.result, 'value preview:', JSON.stringify(json.result)?.slice(0, 300));
              if (json.result) {
                resultText = json.result;
              }
            }
            
            // 3b. 回退：提取 assistant 消息中的 text content 作为 resultText 候选
            // 注意：始终更新 lastAssistantText，因为多轮对话中最后一个 assistant text 才是最终回复
            if (json.type === 'assistant' && json.message?.content) {
              for (const content of json.message.content) {
                if (content.type === 'text' && content.text) {
                  lastAssistantText = content.text;
                }
              }
            }
            
            // 4. 处理进度回调 (Thinking & Tool Use)
            if (options.onProgress) {
              // 思考过程 (Standard Assistant Message)
              if (json.type === 'assistant' && json.message?.content) {
                for (const content of json.message.content) {
                  if (content.type === 'thinking' && content.thinking) {
                     const thought = content.thinking.trim().replace(/[\r\n]+/g, ' ').slice(0, 100);
                     if (thought) options.onProgress(`🤔 ${thought}...`);
                  }
                  if (content.type === 'tool_use') {
                    options.onProgress(`🛠️ 调用工具: ${content.name}`);
                  }
                }
              }

              // 思考过程 (Streaming Delta - theoretical)
              if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
                 const thought = json.delta.thinking.trim().replace(/[\r\n]+/g, ' ').slice(0, 60);
                 if (thought) options.onProgress(`🤔 ${thought}...`);
              }
              
              // 工具执行 (Tool Use Event)
              if (json.type === 'tool_use') {
                 options.onProgress(`🛠️ 调用工具: ${json.name}`);
              }
              
              // 工具结果
              if (json.type === 'user' && json.message?.content) {
                 for (const content of json.message.content) {
                   if (content.type === 'tool_result') {
                     if (content.is_error) {
                        options.onProgress(`❌ 工具执行失败`);
                     } else {
                        options.onProgress(`✅ 工具执行完成`);
                     }
                   }
                 }
              }
            }
            
          } catch (e) {
            // 忽略 JSON 解析错误
          }
        }
      }
    }

    if (process.stderr) {
      for await (const chunk of process.stderr) {
        stderrChunks.push(chunk);
      }
    }

    const exitCode = await process.exited;
    
    // 处理 buffer 中剩余的内容（逐行解析，修复多行 buffer 导致 JSON.parse 失败的 bug）
    if (buffer.trim()) {
        const remainingLines = buffer.split('\n').filter(line => line.trim());
        logger.debug(`[Agent] Buffer remainder: ${remainingLines.length} line(s) to parse`);
        for (const line of remainingLines) {
          try {
            const json = JSON.parse(line.trim());
            if (json.type === 'result') {
              logger.debug('[Agent] Buffer remainder - Result JSON keys:', Object.keys(json).join(', '));
              if (json.result) {
                resultText = json.result;
              }
              if (json.usage && !tokenUsage) {
                tokenUsage = {
                  inputTokens: json.usage.input_tokens || 0,
                  outputTokens: json.usage.output_tokens || 0,
                  cacheCreationInputTokens: json.usage.cache_creation_input_tokens,
                  cacheReadInputTokens: json.usage.cache_read_input_tokens,
                  totalCostUsd: json.total_cost_usd,
                };
                logger.debug('[Agent] Buffer remainder - extracted tokenUsage:', JSON.stringify(tokenUsage));
              }
            }
            if (json.type === 'assistant' && json.message?.content && !resultText) {
              for (const content of json.message.content) {
                if (content.type === 'text' && content.text) {
                  resultText = content.text;
                  logger.debug('[Agent] Buffer remainder - extracted assistant text, length:', resultText.length);
                }
              }
            }
          } catch (e) {
            logger.debug('[Agent] Buffer remainder - failed to parse line:', line.substring(0, 100));
          }
        }
    }

    const fullStdout = Buffer.concat(stdoutChunks).toString('utf-8');

    // 如果 resultText 还是空，用流式解析过程中收集到的 lastAssistantText 兜底
    if (!resultText && lastAssistantText) {
      resultText = lastAssistantText;
      logger.debug('[Agent] Using lastAssistantText as resultText fallback, length:', resultText.length);
    }

    // 如果流式解析没拿到结果（可能是因为某些异常情况），尝试从完整输出中正则提取
    if (!resultText) {
        logger.warn('[Agent] resultText is empty after stream parsing. Trying fallback extraction from full stdout...');
        logger.warn('[Agent] Full stdout length:', fullStdout.length, 'lines:', fullStdout.split('\n').length);
        try {
            // 尝试找到最后一个 type: result 的行，或 assistant 消息中的 text
            const lines = fullStdout.split('\n');
            let lastAssistantTextFallback = '';
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                try {
                    const json = JSON.parse(line);
                    // 优先取 result.result
                    if (json.type === 'result' && json.result) {
                        resultText = json.result;
                        logger.info('[Agent] Fallback: found result.result at line', i);
                        // 修复：Fallback 路径也需要提取 tokenUsage
                        if (json.usage && !tokenUsage) {
                          tokenUsage = {
                            inputTokens: json.usage.input_tokens || 0,
                            outputTokens: json.usage.output_tokens || 0,
                            cacheCreationInputTokens: json.usage.cache_creation_input_tokens,
                            cacheReadInputTokens: json.usage.cache_read_input_tokens,
                            totalCostUsd: json.total_cost_usd,
                          };
                          logger.info('[Agent] Fallback: extracted tokenUsage:', JSON.stringify(tokenUsage));
                        }
                    }
                    // 也收集 assistant text 作为兜底
                    if (json.type === 'assistant' && json.message?.content) {
                        for (const content of json.message.content) {
                            if (content.type === 'text' && content.text) {
                                lastAssistantTextFallback = content.text;
                            }
                        }
                    }
                } catch {}
            }
            // 如果还是没拿到 result，用 assistant text 兜底
            if (!resultText && lastAssistantTextFallback) {
                resultText = lastAssistantTextFallback;
                logger.info('[Agent] Fallback: using lastAssistantTextFallback, length:', resultText.length);
            }
        } catch {}
    }

    return {
      stdout: fullStdout,
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      exitCode,
      sessionId,
      tokenUsage,
      resultText,
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
