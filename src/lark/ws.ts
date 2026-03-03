import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { LarkMessageEvent } from '../types';
import type { EventSource, EventHandler } from './eventsource';
import { getConfig } from '../config';
import { normalizeEvent } from './adapter';
import { logger } from '../utils/logger';

export class LarkWebSocketSource implements EventSource {
  type = 'websocket' as const;
  private client: any;
  private handler: EventHandler | null = null;
  private wsClient: any;

  constructor() {
    const config = getConfig();
    logger.log('[WebSocket] Initializing with appId:', config.lark.appId.substring(0, 8) + '...');
    this.client = new Client({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
    });
  }

  onEvent(handler: EventHandler): void {
    logger.log('[WebSocket] Event handler registered');
    this.handler = handler;
  }

  async start(): Promise<void> {
    logger.log('[WebSocket] Starting WebSocket client...');

    const config = getConfig();
    this.wsClient = new WSClient({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
    });

    logger.log('[WebSocket] Setting up EventDispatcher...');
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        logger.log('[WebSocket] ================ Received Message ================');
        logger.log('[WebSocket] Type:', typeof data);
        logger.log('[WebSocket] Keys:', Object.keys(data || {}));
        logger.log('[WebSocket] Raw data:', JSON.stringify(data, null, 2));
        logger.log('[WebSocket] =============================================');

        if (this.handler) {
          logger.log('[WebSocket] Normalizing event...');
          const normalized = normalizeEvent(data);
          logger.log('[WebSocket] Calling handler with normalized event...');
          this.handler(normalized);
        } else {
          logger.log('[WebSocket] No handler registered!');
        }
      },
    });

    logger.log('[WebSocket] EventDispatcher registered, starting WebSocket...');
    this.wsClient.start({
      eventDispatcher
    });

    logger.log('[WebSocket] WebSocket client started successfully!');
  }

  async stop(): Promise<void> {
    logger.log('[WebSocket] Stopping WebSocket client...');
    if (this.wsClient && typeof this.wsClient.stop === 'function') {
      await this.wsClient.stop();
    }
    logger.log('[WebSocket] WebSocket client stopped');
  }
}
