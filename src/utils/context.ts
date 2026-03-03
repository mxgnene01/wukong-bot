import type { ChatContext, ChatType, LarkMessageEvent, MessageAttachment } from '../types';

export function buildContext(event: LarkMessageEvent): ChatContext {
  const { sender, message } = event.event;
  const chatType = message.chat_type as ChatType;
  const userId = sender.sender_id.open_id;

  let sessionId: string;
  let threadId: string | undefined;

  if (chatType === 'p2p') {
    sessionId = `p2p:${userId}`;
  } else {
    threadId = message.root_id || message.message_id;
    sessionId = `group:${message.chat_id}:${threadId}`;
  }

  return {
    chatType,
    sessionId,
    userId,
    chatId: message.chat_id,
    messageId: message.message_id,
    rootId: message.root_id,
    threadId,
  };
}

/**
 * 提取消息附件信息（图片、语音、文件等）
 */
export function extractMessageAttachments(event: LarkMessageEvent): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  const message = event.event.message;

  try {
    const content = JSON.parse(message.content);

    switch (message.message_type) {
      case 'image': {
        // 图片消息: {"image_key": "file_v2_xxxx"}
        if (content.image_key) {
          attachments.push({
            type: 'image',
            fileKey: content.image_key,
          });
        }
        break;
      }

      case 'audio': {
        // 语音消息: {"file_key": "file_v2_xxxx", "duration": 2.5}
        if (content.file_key) {
          attachments.push({
            type: 'audio',
            fileKey: content.file_key,
            duration: content.duration,
          });
        }
        break;
      }

      case 'file': {
        // 文件消息: {"file_key": "file_v2_xxxx", "file_name": "xxx.pdf"}
        if (content.file_key) {
          attachments.push({
            type: 'file',
            fileKey: content.file_key,
            fileName: content.file_name,
          });
        }
        break;
      }

      case 'media': {
        // 视频消息: {"file_key": "file_v2_xxxx", "file_name": "xxx.mp4", "duration": 10.5}
        if (content.file_key) {
          attachments.push({
            type: 'media',
            fileKey: content.file_key,
            fileName: content.file_name,
            duration: content.duration,
          });
        }
        break;
      }

      case 'post': {
        // 富文本消息中可能包含图片
        // 格式: {"content": [[{"tag":"img","image_key":"file_v2_xxxx"}]]}
        if (content.content && Array.isArray(content.content)) {
          for (const block of content.content) {
            if (Array.isArray(block)) {
              for (const element of block) {
                if (element && element.tag === 'img' && element.image_key) {
                  attachments.push({
                    type: 'image',
                    fileKey: element.image_key,
                    imageWidth: element.width,
                    imageHeight: element.height,
                  });
                }
              }
            }
          }
        }
        break;
      }

      case 'sticker': {
        // 贴纸消息
        if (content.file_key) {
          attachments.push({
            type: 'image',
            fileKey: content.file_key,
          });
        }
        break;
      }
    }
  } catch {
    // 解析失败，静默处理
  }

  return attachments;
}

/**
 * 提取消息文本内容
 * 对于图片/语音/文件消息，返回描述性文本
 */
export function extractMessageContent(event: LarkMessageEvent): string {
  const message = event.event.message;

  try {
    const content = JSON.parse(message.content);

    switch (message.message_type) {
      case 'text': {
        // 普通文本消息
        return content.text || '';
      }

      case 'post': {
        // 富文本消息
        if (content.content && Array.isArray(content.content)) {
          const texts: string[] = [];
          for (const block of content.content) {
            if (Array.isArray(block)) {
              for (const element of block) {
                if (element && element.tag === 'text' && element.text) {
                  texts.push(element.text);
                }
              }
            }
          }
          return texts.join('');
        }
        return '';
      }

      case 'image': {
        const attachments = extractMessageAttachments(event);
        if (attachments.length > 0) {
          return '[图片]';
        }
        return '';
      }

      case 'audio': {
        const attachments = extractMessageAttachments(event);
        if (attachments.length > 0 && attachments[0].duration) {
          return `[语音，时长 ${attachments[0].duration.toFixed(1)} 秒]`;
        }
        return '[语音]';
      }

      case 'file': {
        const attachments = extractMessageAttachments(event);
        if (attachments.length > 0 && attachments[0].fileName) {
          return `[文件: ${attachments[0].fileName}]`;
        }
        return '[文件]';
      }

      case 'media': {
        const attachments = extractMessageAttachments(event);
        if (attachments.length > 0) {
          const duration = attachments[0].duration;
          const fileName = attachments[0].fileName;
          if (fileName && duration) {
            return `[视频: ${fileName}, 时长 ${duration.toFixed(1)} 秒]`;
          } else if (fileName) {
            return `[视频: ${fileName}]`;
          } else if (duration) {
            return `[视频，时长 ${duration.toFixed(1)} 秒]`;
          }
        }
        return '[视频]';
      }

      case 'sticker': {
        return '[贴纸]';
      }

      case 'share_chat': {
        return '[分享群聊]';
      }

      case 'share_user': {
        return '[分享名片]';
      }

      default: {
        return `[${message.message_type}消息]`;
      }
    }
  } catch {
    // JSON 解析失败，返回原始内容
    return message.content || '';
  }
}

export function isMentionedBot(event: LarkMessageEvent, botOpenId: string): boolean {
  if (event.event.message.chat_type === 'p2p') {
    return true;
  }

  const mentions = event.event.message.mentions || [];
  return mentions.some(m => m.id.open_id === botOpenId);
}
