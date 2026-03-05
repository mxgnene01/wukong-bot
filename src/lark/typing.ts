/**
 * 飞书"敲键盘"打字指示器
 *
 * 基于 OpenClaw 实现的学习和迭代：
 * - 使用飞书内置的 "Typing" 表情类型
 * - 支持 keepalive 刷新机制（每 3 秒）
 * - 完整的限流熔断和错误处理
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 */

import { getLarkClient } from './client';
import { logger } from '../utils/logger';

// 飞书内置的"敲键盘"表情类型
const TYPING_EMOJI = 'Typing';

// 限流错误码集合
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);

// [P4 Fix] Keepalive 间隔：3s → 10s，减少 ~70% 的 Lark API 调用
// 飞书 emoji 不会在 10s 内过期，10s 足够保持可见
const KEEPALIVE_INTERVAL_MS = 10000;

/**
 * 打字指示器状态
 */
export interface TypingIndicatorState {
  messageId: string;
  reactionId: string | null;
  keepaliveTimer?: ReturnType<typeof setInterval>;
}

/**
 * 飞书限流错误
 */
export class FeishuBackoffError extends Error {
  code: number;

  constructor(code: number) {
    super(`Feishu API backoff: code ${code}`);
    this.name = 'FeishuBackoffError';
    this.code = code;
  }
}

/**
 * 检查是否为限流错误
 */
function isFeishuBackoffError(err: unknown): err is FeishuBackoffError {
  if (err instanceof FeishuBackoffError) {
    return true;
  }
  const code = getBackoffCodeFromError(err);
  return code !== undefined;
}

/**
 * 从错误对象中提取限流错误码
 */
function getBackoffCodeFromError(err: unknown): number | undefined {
  // Axios 风格错误
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as any).response;
    if (response?.status === 429) {
      return 429;
    }
    if (response?.data?.code && FEISHU_BACKOFF_CODES.has(response.data.code)) {
      return response.data.code;
    }
  }
  // 飞书 SDK 风格错误
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as any).code;
    if (FEISHU_BACKOFF_CODES.has(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * 从响应中提取限流错误码（处理不抛异常但带错误码的情况）
 */
function getBackoffCodeFromResponse(response: any): number | undefined {
  if (response?.code && FEISHU_BACKOFF_CODES.has(response.code)) {
    return response.code;
  }
  return undefined;
}

/**
 * 添加打字指示器（"敲键盘"表情）
 *
 * @param messageId 用户发送的消息 ID
 * @returns 打字指示器状态，包含 reactionId 用于后续删除
 */
export async function addTypingIndicator(messageId: string): Promise<TypingIndicatorState> {
  const client = getLarkClient();
  logger.debug('[Typing] Adding typing indicator to message:', messageId);

  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    // 检查非抛出型的限流响应
    const backoffCode = getBackoffCodeFromResponse(response);
    if (backoffCode !== undefined) {
      throw new FeishuBackoffError(backoffCode);
    }

    const reactionId = response.data?.reaction_id ?? null;
    logger.debug('[Typing] Added typing indicator, reactionId:', reactionId);
    return { messageId, reactionId };
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      logger.warn('[Typing] Feishu backoff error:', err.code);
      throw err;
    }
    // 其他错误静默失败，不影响主流程
    if (err instanceof Error) {
      logger.warn('[Typing] Failed to add typing indicator:', err.message);
    } else {
      logger.warn('[Typing] Failed to add typing indicator');
    }
    return { messageId, reactionId: null };
  }
}

/**
 * 移除打字指示器
 *
 * @param state 从 addTypingIndicator 返回的状态
 */
export async function removeTypingIndicator(state: TypingIndicatorState): Promise<void> {
  // 先停止 keepalive
  stopKeepalive(state);

  if (!state.reactionId) {
    logger.debug('[Typing] No reactionId, skipping removal');
    return;
  }

  const client = getLarkClient();
  logger.debug('[Typing] Removing typing indicator from message:', state.messageId);

  try {
    const result = await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });

    const backoffCode = getBackoffCodeFromResponse(result);
    if (backoffCode !== undefined) {
      throw new FeishuBackoffError(backoffCode);
    }

    logger.debug('[Typing] Removed typing indicator successfully');
  } catch (err) {
    if (isFeishuBackoffError(err)) {
      logger.warn('[Typing] Feishu backoff error on remove:', err.code);
      throw err;
    }
    // 消息已删除、权限变更等非关键错误静默忽略
    if (err instanceof Error) {
      logger.debug('[Typing] Non-critical error removing indicator:', err.message);
    }
  }
}

/**
 * 启动 keepalive 定时器
 * 每 3 秒刷新一次打字指示器，确保长时间处理时表情不会消失
 *
 * @param state 打字指示器状态
 * @returns 更新后的状态（包含定时器）
 */
export function startKeepalive(state: TypingIndicatorState): TypingIndicatorState {
  // 先停止已有的定时器
  stopKeepalive(state);

  logger.debug('[Typing] Starting keepalive for message:', state.messageId);

  const keepaliveTimer = setInterval(async () => {
    try {
      logger.debug('[Typing] Keepalive refresh for message:', state.messageId);
      // 重新添加表情来刷新
      const newState = await addTypingIndicator(state.messageId);
      // 更新 reactionId
      if (newState.reactionId) {
        state.reactionId = newState.reactionId;
      }
    } catch (err) {
      if (isFeishuBackoffError(err)) {
        logger.warn('[Typing] Keepalive hit backoff, stopping timer');
        stopKeepalive(state);
      } else {
        logger.debug('[Typing] Keepalive refresh failed, continuing...');
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  return { ...state, keepaliveTimer };
}

/**
 * 停止 keepalive 定时器
 *
 * @param state 打字指示器状态
 */
export function stopKeepalive(state: TypingIndicatorState): void {
  if (state.keepaliveTimer) {
    logger.debug('[Typing] Stopping keepalive for message:', state.messageId);
    clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = undefined;
  }
}
