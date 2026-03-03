# 架构设计 v2.0

> 参考 [bytedance/deer-flow](https://github.com/bytedance/deer-flow) 的优秀设计模式

## 目录结构

```
src/
├── config/              # 配置系统 (参考 deer-flow)
│   ├── index.ts         # 配置加载器
│   └── schema.ts        # 配置类型定义
├── middleware/          # 中间件管道 (参考 deer-flow)
│   ├── index.ts         # 管道构建器
│   ├── types.ts         # 中间件类型
│   ├── duplicate_check.ts
│   ├── context_builder.ts
│   └── session_manager.ts
├── skills/              # 技能系统 (参考 deer-flow)
│   ├── index.ts         # 技能管理
│   ├── types.ts         # 技能类型
│   ├── registry.ts      # 技能注册
│   └── builtins/        # 内置技能
│       └── index.ts
├── gateway/             # Gateway API
│   ├── index.ts
│   └── app.ts           # Hono 应用
├── worker/              # Worker 执行引擎 (参考 deer-flow)
│   ├── index.ts
│   ├── engine.ts        # 工作引擎
│   └── executor.ts      # 任务执行器
├── agent/               # Claude Code CLI 代理
├── queue/               # 任务队列
├── db/                  # 数据库层
├── session/             # 会话管理
├── cards/               # 飞书卡片
├── lark/                # 飞书 API 客户端
├── cron/                # 定时任务
├── utils/               # 工具函数
├── types/               # 类型定义
├── index.ts             # 主入口
├── gateway.ts           # Gateway-only 入口
└── worker.ts            # Worker-only 入口
```

## 从 deer-flow 借鉴的设计模式

### 1. 配置系统 (Config System)

**deer-flow 设计**:
- 分层配置: `config.yaml` + 环境变量覆盖
- 强类型配置 Schema
- 验证系统

**我们的实现**:
```typescript
// src/config/schema.ts
interface Config {
  app: AppConfig;
  lark: LarkConfig;
  claude: ClaudeConfig;
  database: DatabaseConfig;
  worker: WorkerConfig;
  skills: SkillsConfig;
  // ...
}
```

### 2. 中间件管道 (Middleware Pipeline)

**deer-flow 设计**:
- 9个中间件组成的责任链
- 严格的执行顺序
- pre/post 钩子

**我们的实现**:
```typescript
// src/middleware/types.ts
interface Middleware {
  name: string;
  priority?: number;
  pre?(ctx: MiddlewareContext): Promise<void>;
  post?(ctx: MiddlewareContext): Promise<void>;
  handle?(ctx: MiddlewareContext, next: () => Promise<void>): Promise<void>;
}

// 管道执行顺序:
// 1. duplicate_check (0)
// 2. context_builder (10)
// 3. session_manager (20)
// 4. skill_loader (30)
```

### 3. 技能系统 (Skill System)

**deer-flow 设计**:
- Markdown 定义技能
- 渐进式加载
- 触发匹配

**我们的实现**:
```typescript
// src/skills/types.ts
interface Skill {
  id: string;
  name: string;
  systemPrompt: string;
  triggers: SkillTrigger[]; // keyword, regex, command, intent
  enabled: boolean;
}

// 内置技能: code_review, refactor, test, explain, debug
```

### 4. 执行引擎 (Executor Engine)

**deer-flow 设计**:
- 子代理后台执行
- 并发控制
- 超时管理

**我们的实现**:
```typescript
// src/worker/engine.ts
class WorkerEngine {
  maxConcurrentTasks: number;
  activeTasks: Map<string, Task>;

  // 支持:
  // - 任务排队
  // - 心跳保活
  // - 超时检测
  // - 崩溃恢复
}

// src/worker/executor.ts
class TaskExecutor {
  // 单个任务的完整执行流程:
  // 1. 初始化会话
  // 2. 加载技能
  // 3. 构建提示词
  // 4. 调用 Agent
  // 5. 处理结果
}
```

## 核心数据流

```
飞书消息
    ↓
[Gateway] /webhook/event/v2
    ↓
[Middleware Pipeline]
    ├─ duplicate_check (去重)
    ├─ context_builder (构建上下文)
    ├─ session_manager (会话管理)
    └─ skill_loader (技能匹配)
    ↓
[Queue] 任务入队
    ↓
[Worker Engine]
    ├─ 并发控制 (max 3)
    ├─ 心跳保活
    └─ 超时检测
    ↓
[Task Executor]
    ├─ 加载会话
    ├─ 应用技能
    ├─ 构建 System Prompt
    ├─ 调用 Claude Code CLI
    └─ 保存结果
    ↓
[飞书卡片] 结果回写
```

## 扩展指南

### 添加新的中间件

1. 在 `src/middleware/` 下创建文件
2. 实现 `Middleware` 接口
3. 在 `src/middleware/index.ts` 中注册

```typescript
// src/middleware/my_middleware.ts
export function createMyMiddleware(): Middleware {
  return {
    name: 'my_middleware',
    priority: 15,
    async pre(ctx) {
      // do something
    },
  };
}
```

### 添加新的技能

1. 在 `src/skills/builtins/` 下定义
2. 在 `src/skills/builtins/index.ts` 中导出

```typescript
const mySkill: Skill = {
  id: 'my_skill',
  name: '我的技能',
  systemPrompt: '...',
  triggers: [{ type: 'keyword', pattern: '触发词' }],
  enabled: true,
};
```

## 对比总结

| 特性 | v1.0 | v2.0 (参考 deer-flow) |
|------|------|---------------------|
| 配置管理 | 扁平对象 | 分层 Schema + 验证 |
| 消息处理 | 线性流程 | 中间件管道 |
| 任务执行 | 简单 Worker | Engine + Executor 分离 |
| 技能系统 | 无 | 完整的技能注册/匹配 |
| 可扩展性 | 中等 | 高 (中间件/技能可插拔) |
