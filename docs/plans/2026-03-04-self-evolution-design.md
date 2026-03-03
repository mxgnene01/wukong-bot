# Wukong Bot 自主进化能力技术方案

## 1. 核心目标

让 Wukong Bot 具备“自主编程”和“自我扩展”的能力，从而实现无需人工干预的功能迭代。

**分层设计**：
*   **Level 1 (Scripting)**: 针对临时性、轻量级任务，Bot 编写并执行脚本 (`workspace/scripts/`)。
*   **Level 2 (Skill Creation)**: 针对复杂、可复用能力，利用 Claude Code 原生的 `/skill-creator` 工具生成标准技能 (`workspace/skills/`)。

---

## 2. Level 1: 轻量级脚本执行 (Ad-hoc Tasks)

### 2.1 目录结构
```
workspace/scripts/
├── metadata.json       # 脚本索引与元数据
├── clean_logs.py       # 实际脚本文件
├── data_analysis.ts
└── ...
```

### 2.2 元数据管理 (`metadata.json`)
```json
{
  "clean_logs.py": {
    "description": "清理 7 天前的日志文件并打包备份",
    "language": "python",
    "created_at": "2026-03-04T10:00:00Z",
    "usage": "python clean_logs.py --days 7",
    "author": "wukong-bot"
  }
}
```

### 2.3 交互流程
1.  **用户指令**：“帮我写个脚本清理日志。”
2.  **Bot 动作**：
    *   在 `workspace/scripts/` 下创建 `clean_logs.py`。
    *   读取并更新 `metadata.json`。
    *   执行脚本：`python workspace/scripts/clean_logs.py`。
    *   反馈执行结果。
3.  **复用机制**：下次用户说“清理日志”时，Bot 检索元数据，直接复用脚本。

---

## 3. Level 2: 技能自我创造 (Skill Creation)

### 3.1 核心机制
直接复用 Claude Code CLI 强大的原生能力 `/skill-creator`。

*   **触发方式**：Bot 在对话中识别到用户意图是“创建一个新技能”时，调用 Claude 的内置工具。
*   **生成产物**：Claude 会自动生成符合最佳实践的 Skill Markdown 文件。
*   **存放位置**：`workspace/skills/`（需要确保 Claude CLI 的配置指向此目录）。

### 3.2 自动加载 (Auto-Loader)
*   **机制**：`src/skills/loader/index.ts` 已经实现了 `fs.watch` 监听。
*   **流程**：
    1.  Claude CLI 生成 `workspace/skills/new-skill.md`。
    2.  `SkillLoader` 监听到文件创建事件。
    3.  自动解析 Front Matter 和 Prompt。
    4.  注册到 `SkillRegistry`。
    5.  **即时生效**：用户无需重启 Bot 即可使用新技能。

---

## 4. 实施计划

### 4.1 脚本管理能力
- [ ] 创建 `workspace/scripts/` 目录。
- [ ] 初始化 `workspace/scripts/metadata.json`。
- [ ] (可选) 给 Agent 增加 `script_manager` 工具（读写脚本和元数据），或者直接依赖 Claude 的文件操作能力。

### 4.2 技能创造能力
- [ ] 验证 Claude Code CLI 的 `/skill-creator` 是否能正确写入 `workspace/skills/`。
- [ ] 确保 `SkillLoader` 能正确解析 Claude 生成的 Markdown 格式（特别是 Front Matter）。

### 4.3 权限与安全
- [ ] 确保 Bot 对 `workspace/` 目录有读写权限。
- [ ] (可选) 限制脚本执行的权限（如禁止网络访问，或仅限特定域名）。
