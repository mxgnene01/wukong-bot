import type { Middleware, MiddlewareContext } from './types';
import { getDB } from '../db';

export function createDuplicateCheckMiddleware(): Middleware {
  const db = getDB();

  return {
    name: 'duplicate_check',
    priority: 0,

    async pre(ctx: MiddlewareContext) {
      if (!ctx.event) {
        console.log('[Middleware] ctx.event:', ctx.event);
      }
      if (!ctx.event || !ctx.event.header) return;

      const eventId = ctx.event.header.event_id;
      const key = `event:${eventId}`;
      const existing = db.getSetting(key);

      if (existing) {
        ctx.stopped = true;
        ctx.extra.duplicate = true;
        return;
      }

      db.setSetting(key, '1');
      ctx.extra.eventId = eventId;
    },
  };
}
