# Metacognitive Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Wukong Bot into a Metacognitive Agent System with self-monitoring, evaluation, reflection, and self-evolution capabilities, leveraging existing `bytedance-find-skills` and `skill-creator` infrastructure.

**Architecture:**
The system moves from a linear Request-Response model to a **Metacognitive Loop (OODA Loop)**.
- **Observe:** Monitor user inputs, system state, and task outcomes (Heartbeat/Sensors).
- **Orient:** Contextualize using Long-Term Memory and Reflection (Memory System).
- **Decide:** Plan actions using Skills or create new ones (Self-Modification).
- **Act:** Execute via Executor and specialized Agents.

**Tech Stack:** TypeScript, Bun, SQLite (Memory/State), Claude Code CLI (Evolution), Cron (Heartbeat).

---

## Phase 1: Architecture Mapping & Foundation

### Task 1: Architecture Design Document
**Goal:** Define the 5 core mechanisms and map them to existing code.

**Files:**
- Create: `docs/architecture/metacognitive-system.md`

**Step 1: Write Architecture Spec**
Create a detailed document defining:
1.  **Metacognitive Loop**: How `src/worker/engine.ts` will evolve into a continuous loop.
2.  **Memory System**: Enhancing `src/session/memory.ts` for Facts, Reflections, and Procedures.
3.  **Reflection Engine**: A new component `src/reflection/index.ts` for post-task analysis.
4.  **Heartbeat/Thinking Clock**: Upgrading `src/stats/scheduler.ts` to a general `src/clock/index.ts`.
5.  **Self-Modification**: Formalizing `src/skills/builtins/index.ts` into `src/evolution/index.ts`.

**Step 2: Commit**
```bash
git add docs/architecture/metacognitive-system.md
git commit -m "docs: add metacognitive system architecture spec"
```

---

## Phase 2: Memory System Upgrade (The "Orient" Phase)

### Task 2: Enhanced Memory Schema
**Goal:** Store structured Facts and Reflections, not just chat logs.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/types/index.ts`

**Step 1: Update DB Schema**
Add tables for `memories` (facts), `reflections` (insights), and `skills_metadata` (evolution tracking).

```typescript
// src/db/schema.ts
export const schema = `
  -- Existing tables...

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT, -- 'fact', 'preference', 'constraint'
    confidence REAL DEFAULT 1.0,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    trigger TEXT, -- what caused the reflection
    content TEXT, -- the insight
    actionable_item TEXT, -- what to do differently
    created_at INTEGER
  );
`;
```

**Step 2: Update Types**
Define interfaces for `Memory` and `Reflection`.

**Step 3: Commit**
```bash
git add src/db/schema.ts src/types/index.ts
git commit -m "feat: add memory and reflection schema"
```

---

## Phase 3: Reflection Engine (The "Evaluation" Phase)

### Task 3: Implement Reflection Engine
**Goal:** Analyze task outcomes to generate insights.

**Files:**
- Create: `src/reflection/index.ts`
- Create: `src/reflection/evaluator.ts`

**Step 1: Create Evaluator**
Implement logic to evaluate task success/failure.
- Input: Task Result, User Feedback (if any).
- Output: Score (0-1), Critique.

**Step 2: Create Reflection Generator**
Implement logic to generate insights from evaluations.
- If Score < 0.5: "Why did I fail? What skill was missing?"
- If Score > 0.9: "This pattern works well, should I save it as a skill?"

**Step 3: Commit**
```bash
git add src/reflection/
git commit -m "feat: implement reflection engine"
```

---

## Phase 4: Self-Evolution Engine (The "Self-Modification" Phase)

### Task 4: Unified Evolution Interface
**Goal:** Encapsulate `bytedance-find-skills` and `skill-creator` into a programmatic API.

**Files:**
- Create: `src/evolution/index.ts`
- Create: `src/evolution/skill-manager.ts`

**Step 1: Implement Skill Discovery**
Wrap `bytedance-find-skills` CLI/Skill usage into a function `findSkill(query: string): Promise<Skill | null>`.

**Step 2: Implement Skill Creation**
Wrap `skill-creator` usage into `createSkill(spec: SkillSpec): Promise<Skill>`.
- This replaces the raw prompt logic in `metaLearningSkill`.

**Step 3: Commit**
```bash
git add src/evolution/
git commit -m "feat: implement self-evolution engine"
```

---

## Phase 5: The Metacognitive Loop (The "Core" Phase)

### Task 5: Upgrade Worker Engine
**Goal:** Transform the linear worker into a loop that uses the above components.

**Files:**
- Modify: `src/worker/engine.ts`
- Modify: `src/worker/executor.ts`

**Step 1: Inject Pre-Task Analysis**
Before executing:
1.  Query Memory for relevant facts.
2.  Query Evolution Engine for missing skills.

**Step 2: Inject Post-Task Reflection**
After executing:
1.  Call Reflection Engine.
2.  Store insights in Memory.
3.  Trigger Self-Modification if reflection suggests a new skill is needed.

**Step 3: Commit**
```bash
git add src/worker/
git commit -m "feat: integrate metacognitive loop into worker engine"
```

---

## Phase 6: Thinking Clock (The "Heartbeat" Phase)

### Task 6: Implement Background Thinking
**Goal:** Allow the bot to "think" (reflect/clean up) when idle.

**Files:**
- Modify: `src/index.ts`
- Create: `src/clock/index.ts`

**Step 1: Create Thinking Clock**
A cron-like service that runs every N minutes when system load is low.
- Actions: Consolidate memories, clean up logs, optimize skills.

**Step 2: Commit**
```bash
git add src/clock/
git commit -m "feat: implement thinking clock"
```
