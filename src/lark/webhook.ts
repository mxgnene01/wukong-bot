import { gatewayApp } from '../gateway/index';
import type { LarkMessageEvent } from '../types';
import type { EventSource, EventHandler } from './eventsource';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

export class LarkWebhookSource implements EventSource {
  type = 'webhook' as const;
  private handler: EventHandler | null = null;
  private server: any = null;

  constructor() {
    this.setupEventForwarding();
  }

  private setupEventForwarding() {
  }

  onEvent(handler: EventHandler): void {
    logger.log('[Webhook] Event handler registered');
    this.handler = handler;
    (globalThis as any).__larkEventHandler = handler;
  }

  async start(): Promise<void> {
    const config = getConfig();
    logger.log('[Webhook] Starting HTTP server on port', config.app.port);

    this.server = Bun.serve({
      port: config.app.port,
      fetch: gatewayApp.fetch,
    });

    logger.log('[Webhook] HTTP server listening on', this.server.url);
  }

  async stop(): Promise<void> {
    logger.log('[Webhook] Stopping HTTP server...');
    if (this.server) {
      this.server.stop();
    }
    logger.log('[Webhook] HTTP server stopped');
  }

  static dispatchEvent(event: LarkMessageEvent) {
    const handler = (globalThis as any).__larkEventHandler;
    if (handler) {
      handler(event);
    }
  }
}
