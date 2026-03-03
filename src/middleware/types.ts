// 参考 deer-flow 的中间件设计

import type { ChatContext, LarkMessageEvent, QueueTask, MessageAttachment } from '../types';

export interface MiddlewareContext {
  event?: LarkMessageEvent;
  task?: QueueTask;
  context?: ChatContext;
  content?: string;
  attachments?: MessageAttachment[];
  session?: any;
  skills?: string[];
  extra: Record<string, any>;
  stopped: boolean;
}

export interface Middleware {
  name: string;
  priority?: number;
  enabled?: boolean;
  pre?(ctx: MiddlewareContext): Promise<void> | void;
  post?(ctx: MiddlewareContext): Promise<void> | void;
  handle?(ctx: MiddlewareContext, next: () => Promise<void>): Promise<void>;
}

export class MiddlewarePipeline {
  private middlewares: Middleware[] = [];

  use(middleware: Middleware) {
    if (middleware.enabled !== false) {
      this.middlewares.push(middleware);
      this.sort();
    }
    return this;
  }

  private sort() {
    this.middlewares.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  }

  async execute(ctx: MiddlewareContext): Promise<MiddlewareContext> {
    let index = 0;

    const next = async () => {
      if (index < this.middlewares.length && !ctx.stopped) {
        const middleware = this.middlewares[index++];

        if (middleware.handle) {
          await middleware.handle(ctx, next);
        } else {
          if (middleware.pre) {
            await middleware.pre(ctx);
          }
          await next();
          if (middleware.post) {
            await middleware.post(ctx);
          }
        }
      }
    };

    await next();
    return ctx;
  }

  clear() {
    this.middlewares = [];
  }
}
