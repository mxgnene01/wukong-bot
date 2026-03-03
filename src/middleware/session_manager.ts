import type { Middleware, MiddlewareContext } from './types';
import { getSessionManager } from '../session';
import { getMemoryManager } from '../session/memory';

export function createSessionManagerMiddleware(): Middleware {
  const sessionManager = getSessionManager();
  const memoryManager = getMemoryManager();

  return {
    name: 'session_manager',
    priority: 20,

    async pre(ctx: MiddlewareContext) {
      if (!ctx.context) return;

      ctx.session = sessionManager.getOrCreateSession(ctx.context);
    },

    async post(ctx: MiddlewareContext) {
      if (ctx.session && ctx.content) {
        memoryManager.saveUserMessage(ctx.session.sessionId, ctx.content);
      }
    },
  };
}
