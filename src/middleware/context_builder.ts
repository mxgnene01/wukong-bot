import type { Middleware, MiddlewareContext } from './types';
import { buildContext, extractMessageContent, extractMessageAttachments } from '../utils/context';
import { logger } from '../utils/logger';

export function createContextBuilderMiddleware(): Middleware {
  return {
    name: 'context_builder',
    priority: 10,

    async pre(ctx: MiddlewareContext) {
      // [P5 Fix] 只打摘要，不打完整 event JSON
      const eventId = ctx.event?.header?.event_id || 'unknown';
      logger.debug(`[Middleware] context_builder processing event: ${eventId}`);

      if (!ctx.event || !ctx.event.header) {
        logger.warn('[Middleware] ctx.event or ctx.event.header missing:', ctx.event);
        return;
      }

      logger.info('[Middleware] Building context...');
      ctx.context = buildContext(ctx.event);
      ctx.content = extractMessageContent(ctx.event).trim();
      ctx.attachments = extractMessageAttachments(ctx.event);

      logger.debug('[Middleware] Context built, content length:', ctx.content?.length || 0);
      logger.debug('[Middleware] Attachments count:', ctx.attachments?.length || 0);

      // 只有纯空内容才停止（但有附件的消息可以继续处理）
      if (!ctx.content && (!ctx.attachments || ctx.attachments.length === 0)) {
        ctx.stopped = true;
        ctx.extra.emptyContent = true;
      }
    },
  };
}
