/**
 * 飞书文件下载和处理模块
 *
 * 支持下载图片、语音、文件等飞书消息附件
 */

import { getLarkClient } from './client';
import { logger } from '../utils/logger';
import type { MessageAttachment } from '../types';

export interface DownloadedFile {
  fileKey: string;
  type: MessageAttachment['type'];
  data: Buffer;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

/**
 * 从飞书下载文件
 *
 * @param messageId 消息 ID
 * @param fileKey 文件 key（从 attachment 中获取）
 * @returns 下载的文件数据
 */
export async function downloadFile(
  messageId: string,
  fileKey: string
): Promise<Buffer> {
  const client = getLarkClient();
  logger.info('[File] Downloading file, messageId:', messageId, 'fileKey:', fileKey);

  try {
    const res = await client.im.messageResource.get({
      params: {
        type: 'file',
      },
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
    });

    // Node SDK 的 messageResource.get 返回的是一个包含 stream 的对象
    // 我们需要将 stream 转换为 Buffer
    const stream = await res.getReadableStream();
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err: Error) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  } catch (error: any) {
    logger.error('[File] Failed to download file:', error?.message || error);
    throw error;
  }
}

/**
 * 下载消息中的所有附件
 *
 * @param messageId 消息 ID
 * @param attachments 附件列表
 * @returns 下载后的文件列表
 */
export async function downloadAttachments(
  messageId: string,
  attachments: MessageAttachment[]
): Promise<DownloadedFile[]> {
  const results: DownloadedFile[] = [];

  for (const attachment of attachments) {
    try {
      const data = await downloadFile(messageId, attachment.fileKey);
      results.push({
        fileKey: attachment.fileKey,
        type: attachment.type,
        data,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
      });
      logger.info('[File] Downloaded attachment:', attachment.type, attachment.fileKey);
    } catch (error) {
      logger.error('[File] Failed to download attachment:', attachment.fileKey, error);
      // 继续下载其他附件，不因为一个失败而全部中断
    }
  }

  return results;
}

/**
 * 保存文件到本地（可选）
 *
 * @param data 文件数据
 * @param filePath 保存路径
 */
export async function saveFileToDisk(data: Buffer, filePath: string): Promise<void> {
  await Bun.write(filePath, data);
  logger.info('[File] Saved file to:', filePath);
}

/**
 * 从 Buffer 检测图片格式
 * 支持: PNG, JPEG, GIF, WebP, BMP
 */
export function detectImageType(data: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | null {
  if (data.length < 8) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return 'gif';
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return 'webp';
  }

  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return 'bmp';
  }

  return null;
}

/**
 * 检测音频格式
 * 支持: MP3, WAV, OGG, M4A
 */
export function detectAudioType(data: Buffer): 'mp3' | 'wav' | 'ogg' | 'm4a' | null {
  if (data.length < 12) return null;

  // MP3: ID3xx 或 FF FB
  if (
    (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) ||
    (data[0] === 0xff && data[1] === 0xfb)
  ) {
    return 'mp3';
  }

  // WAV: 52 49 46 46 ... 57 41 56 45
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45
  ) {
    return 'wav';
  }

  // OGG: 4F 67 67 53
  if (data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
    return 'ogg';
  }

  // M4A: 00 00 00 1C 66 74 79 70 4D 34 41
  if (
    data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70 &&
    data[8] === 0x4d && data[9] === 0x34 && data[10] === 0x41
  ) {
    return 'm4a';
  }

  return null;
}

/**
 * 获取文件的 base64 编码（用于传递给 LLM）
 */
export function toBase64(data: Buffer, mimeType?: string): string {
  const base64 = data.toString('base64');
  if (mimeType) {
    return `data:${mimeType};base64,${base64}`;
  }
  return base64;
}
