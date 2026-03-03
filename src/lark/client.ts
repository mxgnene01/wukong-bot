import { Client } from '@larksuiteoapi/node-sdk';
import { config } from '../utils/config';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import type { LarkCard } from '../cards';
import type { ChatContext } from '../types';
import type { EventSource } from './eventsource';

let clientInstance: Client | null = null;
let botOpenId: string | null = null;

export function getLarkClient(): Client {
  if (!clientInstance) {
    clientInstance = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }
  return clientInstance;
}

export async function getBotOpenId(): Promise<string> {
  if (botOpenId) return botOpenId;

  const client = getLarkClient();
  const res = await client.contact.user.get({
    params: {
      user_id_type: 'open_id',
    },
    path: {
      user_id: 'me',
    },
  });

  botOpenId = res.data?.user?.open_id || '';
  return botOpenId;
}

export async function sendCard(
  context: ChatContext,
  card: LarkCard,
  replyToMessageId?: string
): Promise<string> {
  const client = getLarkClient();
  const cardJson = JSON.stringify(card);

  logger.info('[Lark] sendCard called, replyToMessageId:', replyToMessageId);
  logger.debug('[Lark] Card JSON:', cardJson);

  try {
    if (replyToMessageId) {
      logger.info('[Lark] Replying to message:', replyToMessageId);
      const res = await client.im.message.reply({
        path: {
          message_id: replyToMessageId,
        },
        data: {
          msg_type: 'interactive',
          content: cardJson,
          uuid: crypto.randomUUID(),
        },
      });
      logger.info('[Lark] Reply response:', res);
      return res.data?.message_id || '';
    }

    if (context.chatType === 'p2p') {
      logger.info('[Lark] Sending to p2p, userId:', context.userId);
      const res = await client.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: context.userId || '',
          msg_type: 'interactive',
          content: cardJson,
          uuid: crypto.randomUUID(),
        },
      });
      logger.info('[Lark] P2P send response:', res);
      return res.data?.message_id || '';
    } else {
      if (context.threadId) {
        logger.info('[Lark] Sending to group with threadId:', context.threadId);
        const res = await client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: context.chatId || '',
            msg_type: 'interactive',
            content: cardJson,
            uuid: crypto.randomUUID(),
            thread_id: context.threadId,
          } as any,
        });
        logger.info('[Lark] Group thread send response:', res);
        return res.data?.message_id || '';
      } else {
        logger.info('[Lark] Sending to group, chatId:', context.chatId);
        const res = await client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: context.chatId || '',
            msg_type: 'interactive',
            content: cardJson,
            uuid: crypto.randomUUID(),
          },
        });
        logger.info('[Lark] Group send response:', res);
        return res.data?.message_id || '';
      }
    }
  } catch (error: any) {
    logger.error('[Lark] sendCard error:', error);
    logger.error('[Lark] Error details:', JSON.stringify(error, null, 2));
    return '';
  }
}

export async function updateCard(messageId: string, card: LarkCard) {
  const client = getLarkClient();
  const cardJson = JSON.stringify(card);

  logger.info('[Lark] updateCard called, messageId:', messageId);
  logger.debug('[Lark] Update card JSON:', cardJson);

  try {
    const res = await client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: cardJson,
      },
    });
    logger.info('[Lark] updateCard response:', res);
  } catch (error: any) {
    logger.error('[Lark] updateCard error:', error);
    logger.error('[Lark] updateCard error details:', JSON.stringify(error, null, 2));
    // Don't throw - just log and continue
  }
}

export async function sendText(
  context: ChatContext,
  text: string,
  replyToMessageId?: string
): Promise<string> {
  const client = getLarkClient();
  
  // 全局处理换行符转义问题
  // 将字面量 "\n" (backslash + n) 替换为真正的换行符
  // 同时处理可能的多重转义
  const processedText = text.replace(/\\n/g, '\n').replace(/\\\\n/g, '\\n');
  const content = JSON.stringify({ text: processedText });

  try {
    if (replyToMessageId) {
      const res = await client.im.message.reply({
        path: {
          message_id: replyToMessageId,
        },
        data: {
          msg_type: 'text',
          content,
          uuid: crypto.randomUUID(),
        },
      });
      return res.data?.message_id || '';
    }

    if (context.chatType === 'p2p') {
      const res = await client.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: context.userId || '',
          msg_type: 'text',
          content,
          uuid: crypto.randomUUID(),
        },
      });
      return res.data?.message_id || '';
    } else {
      const res = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: context.chatId || '',
          msg_type: 'text',
          content,
          uuid: crypto.randomUUID(),
          thread_id: context.threadId,
        } as any,
      });
      return res.data?.message_id || '';
    }
  } catch (error: any) {
    logger.error('[Lark] sendText error:', error);
    logger.error('[Lark] sendText error details:', JSON.stringify(error, null, 2));
    return '';
  }
}

/**
 * 判断内容是否应该使用卡片模式
 * - 优先使用纯文本提高坪效
 * - 卡片模式：仅在必须要卡片时才使用（代码块、超长文本等）
 */
export function shouldUseCard(content: string): boolean {
  // 只有包含代码块时才强制用卡片（否则代码格式会乱）
  if (content.includes('```')) {
    return true;
  }
  // 文本非常长时才用卡片（超过 2000 字）
  if (content.length > 2000) {
    return true;
  }
  // 其他情况全部用纯文本，提高坪效
  return false;
}

/**
 * 智能发送消息 - 自动选择卡片或文本模式
 */
export async function sendMessageSmart(
  context: ChatContext,
  content: string,
  success: boolean = true,
  duration?: number,
  taskId?: string,
  replyToMessageId?: string
): Promise<string> {
  if (shouldUseCard(content)) {
    logger.info('[Lark] Using card mode for response');
    const { buildResultCard } = await import('../cards');
    return await sendCard(
      context,
      buildResultCard(success, content, duration || 0, taskId),
      replyToMessageId
    );
  } else {
    logger.info('[Lark] Using plain text mode for response');
    return await sendText(context, content, replyToMessageId);
  }
}

export async function getFileInfo(messageId: string, fileKey: string) {
  const client = getLarkClient();
  const res = await client.im.messageResource.get({
    params: {
      type: 'file',
    },
    path: {
      message_id: messageId,
      file_key: fileKey,
    },
  });
  return res;
}

export async function createEventSource(): Promise<EventSource> {
  const config = getConfig();

  if (config.app.eventSource === 'websocket') {
    const { LarkWebSocketSource } = await import('./ws');
    return new LarkWebSocketSource();
  } else {
    const { LarkWebhookSource } = await import('./webhook');
    return new LarkWebhookSource();
  }
}

/**
 * 给消息添加表情反应
 * @param messageId 消息 ID
 * @param emojiType 表情类型，飞书支持的表情类型，如 "WOW"、"THUMBSUP"、"Typing" 等
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
 */
export async function addReaction(messageId: string, emojiType: string = 'THUMBSUP'): Promise<string | null> {
  const client = getLarkClient();
  logger.info('[Lark] Adding reaction to message:', messageId, 'emoji:', emojiType);

  try {
    const res = await client.im.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: { emoji_type: emojiType },
      },
    });
    logger.info('[Lark] Add reaction response:', res);
    return res.data?.reaction_id || null;
  } catch (error: any) {
    // 只打印简洁的错误信息，不打印完整堆栈
    if (error.response?.data?.msg) {
      logger.error('[Lark] addReaction error:', error.response.data.msg);
    } else if (error.message) {
      logger.error('[Lark] addReaction error:', error.message);
    } else {
      logger.error('[Lark] addReaction error:', error);
    }
    // 表情可能已经添加过了，不要抛出错误
    return null;
  }
}

/**
 * 删除消息的表情反应
 * @param messageId 消息 ID
 * @param reactionId 反应 ID（从 addReaction 返回），如果不传则删除所有自己添加的反应
 * @param emojiType 表情类型，如果不传则删除所有自己添加的反应
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete
 */
export async function removeReaction(
  messageId: string,
  reactionId?: string,
  emojiType?: string
): Promise<void> {
  const client = getLarkClient();
  logger.info('[Lark] Removing reaction from message:', messageId);

  try {
    if (reactionId) {
      // 删除指定的 reaction
      await client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
    } else if (emojiType) {
      // 删除指定类型的表情（需要先获取列表）
      try {
        const res = await client.im.messageReaction.list({
          path: {
            message_id: messageId,
          },
        });
        const reactions = (res.data as any)?.items || [];

        for (const reaction of reactions) {
          const reactionEmoji = reaction.reaction_type?.emoji_type;
          const isSelfAdded = reaction.is_self_added;
          const reactionId = reaction.reaction_id;
          if (reactionEmoji === emojiType && isSelfAdded && reactionId) {
            await client.im.messageReaction.delete({
              path: {
                message_id: messageId,
                reaction_id: reactionId,
              },
            });
          }
        }
      } catch (e: any) {
        // 只打印简洁的错误信息
        if (e.response?.data?.msg) {
          logger.warn('[Lark] Failed to list reactions for deletion:', e.response.data.msg);
        } else if (e.message) {
          logger.warn('[Lark] Failed to list reactions for deletion:', e.message);
        } else {
          logger.warn('[Lark] Failed to list reactions for deletion:', e);
        }
      }
    }
    logger.info('[Lark] Reaction removed successfully');
  } catch (error: any) {
    // 只打印简洁的错误信息
    if (error.response?.data?.msg) {
      logger.error('[Lark] removeReaction error:', error.response.data.msg);
    } else if (error.message) {
      logger.error('[Lark] removeReaction error:', error.message);
    } else {
      logger.error('[Lark] removeReaction error:', error);
    }
    // 删除失败不要抛出错误
  }
}

/**
 * 快捷方法：给消息添加"敲键盘"表情 (Typing)
 * 已迁移至 typing.ts，此处保留向后兼容
 */
export async function addTypingReaction(messageId: string): Promise<string | null> {
  const { addTypingIndicator } = await import('./typing');
  const state = await addTypingIndicator(messageId);
  return state.reactionId;
}

/**
 * 快捷方法：删除消息的"敲键盘"表情
 * 已迁移至 typing.ts，此处保留向后兼容
 */
export async function removeTypingReaction(messageId: string): Promise<void> {
  await removeReaction(messageId, undefined, 'Typing');
}

export * from './eventsource';
export * from './typing';
export * from './file';
