import type { LarkMessageEvent } from '../types';
import { logger } from '../utils/logger';

// 适配 WebSocket 和 Webhook 两种数据格式
export function normalizeEvent(rawEvent: any): LarkMessageEvent {
  logger.info('[Adapter] Normalizing event:', typeof rawEvent, Object.keys(rawEvent || {}));

  // 如果已经是标准格式，直接返回
  if (rawEvent.header && rawEvent.event) {
    logger.info('[Adapter] Already in standard format');
    return rawEvent as LarkMessageEvent;
  }

  // WebSocket 扁平格式，需要包装成标准格式
  logger.info('[Adapter] Converting WebSocket flat format to standard format');

  // 从扁平结构中提取 header 相关字段
  const header = {
    event_id: rawEvent.event_id,
    event_type: rawEvent.event_type,
    create_time: rawEvent.create_time,
    token: rawEvent.token,
    app_id: rawEvent.app_id,
    tenant_key: rawEvent.tenant_key,
  };

  // 剩下的部分作为 event
  const {
    event_id,
    event_type,
    create_time,
    token,
    app_id,
    tenant_key,
    ...event
  } = rawEvent;

  const normalized = {
    header,
    event,
  };

  logger.debug('[Adapter] Normalized event:', JSON.stringify(normalized, null, 2));

  return normalized as LarkMessageEvent;
}
