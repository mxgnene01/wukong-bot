# 功能增强设计文档

**日期**: 2026-03-03
**版本**: v2.2.0

## 概述

本次增强包含以下功能：

1. Claude CLI 增强参数
2. 流式输出 + 分批更新卡片
3. 安全约束 + 卡片确认
4. 定时任务自然语言解析

---

## 1. Claude CLI 增强参数

### 新增参数

| 参数 | 说明 |
|------|------|
| `--resume <sessionId>` | 恢复会话，保持上下文 |
| `--output-format stream-json` | 流式输出格式 |
| `--dangerously-skip-permissions` | 跳过权限确认（个人本地使用） |
| `--append-system-prompt` | 注入安全约束 |

### 修改文件

- `src/agent/index.ts`

---

## 2. 流式输出 + 分批更新卡片

### 设计

- 使用 `--output-format stream-json` 获取结构化输出
- 每 2 秒或积累 500 字符更新一次卡片
- 避免频繁更新导致卡片闪烁

### 新增文件

- `src/agent/stream.ts` - 流式输出处理器

### 修改文件

- `src/worker/executor.ts` - 集成流式输出

---

## 3. 安全约束 + 卡片确认

### 设计

- 检测输出中的危险操作
- 发送带"确认/取消"按钮的卡片
- 等待用户点击后再继续执行

### 危险操作列表

- `rm / rm -rf` - 删除文件
- `git push --force / git reset --hard`
- `DROP TABLE / DELETE FROM` - 数据库操作

### 新增文件

- `src/confirmation/index.ts` - 安全确认流程

### 修改文件

- `src/worker/executor.ts` - 集成确认流程

---

## 4. 定时任务自然语言解析

### 设计

```
用户: 定时 每天早上10点 总结一下 AI 新闻
Bot: ✅ 已添加定时任务
     任务: 总结一下 AI 新闻
     时间: 每天 10:00
```

### 实现方式

- 用 Claude 解析自然语言 → cron 表达式
- 任务持久化到 SQLite
- 到点自动执行并推送结果

### 新增文件

- `src/cron/parser.ts` - 自然语言解析器

### 修改文件

- `src/cron/index.ts` - 集成解析器

---

## 新增/修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/index.ts` | 修改 | 增强 Agent，支持新参数 |
| `src/agent/stream.ts` | 新增 | 流式输出处理 |
| `src/confirmation/index.ts` | 新增 | 安全确认流程 |
| `src/cron/parser.ts` | 新增 | 自然语言解析 |
| `src/worker/executor.ts` | 修改 | 集成确认流程和流式输出 |
| `src/types/index.ts` | 修改 | 新增类型定义 |

---

## 实现顺序

1. Claude Agent 增强参数
2. 流式输出 + 分批更新卡片
3. 安全约束 + 卡片确认
4. 定时任务自然语言解析
