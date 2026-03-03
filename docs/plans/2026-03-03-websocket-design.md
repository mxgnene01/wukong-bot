# 飞书 WebSocket 长连接模式实现计划

**日期**: 2026-03-03
**版本**: v2.1.0

## 概述

添加飞书 WebSocket 长连接模式支持，无需内网穿透即可本地开发。

## 设计目标

1. 支持 WebSocket 和 Webhook 双模式切换
2. 复用现有的事件处理逻辑（中间件、队列、Worker）
3. 提供简洁的配置切换方式

## 架构设计

```
┌─────────────────────────────────────────────────┐
│         事件源层 (Event Source Layer)           │
├─────────────────────────────────────────────────┤
│  ┌──────────────────┐    ┌──────────────────┐  │
│  │ WebSocket 模式   │    │  Webhook 模式    │  │
│  │ (src/lark/ws.ts) │    │ (src/gateway/)   │  │
│  └────────┬─────────┘    └────────┬─────────┘  │
└───────────┼──────────────────────────┼───────────┘
            │                          │
            └──────────┬───────────────┘
                       ↓
         ┌─────────────────────┐
         │   事件处理管道      │
         │ (中间件 → 队列)     │
         └──────────┬──────────┘
                    ↓
         ┌─────────────────────┐
         │   Worker 执行引擎   │
         └─────────────────────┘
```

## 实现步骤

### 1. 创建事件源抽象接口 (`src/lark/eventsource.ts`)

定义统一的 `EventSource` 接口，WebSocket 和 Webhook 都实现这个接口。

### 2. 实现 WebSocket 事件源 (`src/lark/ws.ts`)

使用 `Lark.WSClient` API：
```typescript
const wsClient = new Lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
});
wsClient.start({ eventDispatcher });
```

### 3. 重构 Webhook 为事件源 (`src/lark/webhook.ts`)

将现有的 Hono 路由包装为 `EventSource` 接口。

### 4. 更新配置 (`src/config/schema.ts`)

添加 `app.eventSource` 配置项，支持 `'websocket' | 'webhook'`。

### 5. 更新主入口 (`src/index.ts`)

根据配置选择事件源，统一处理事件。

### 6. 更新 lark/client.ts (可选)

如果需要，添加 `sendCardMessage` 和 `updateCardMessage` 方法。

## 配置变更

新增环境变量：
```bash
# 可选，默认 webhook
EVENT_SOURCE=websocket  # 或 webhook
```

## 回退方案

如果 WebSocket 模式有问题，可以随时切回 Webhook 模式：
```bash
EVENT_SOURCE=webhook
```
