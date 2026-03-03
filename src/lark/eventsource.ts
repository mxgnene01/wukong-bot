import type { LarkMessageEvent } from '../types';

export interface EventSource {
  type: 'websocket' | 'webhook';
  onEvent(handler: (event: LarkMessageEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type EventHandler = (event: LarkMessageEvent) => void;
