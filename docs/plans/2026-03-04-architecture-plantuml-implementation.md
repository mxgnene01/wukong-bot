# Architecture PlantUML Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a high-level architecture PlantUML diagram for the Wukong Bot project.

**Architecture:** This is a simple documentation task - we will create a single PlantUML file that visualizes the project's component architecture and dependencies.

**Tech Stack:** PlantUML

---

### Task 1: Create the PlantUML Architecture Diagram

**Files:**
- Create: `architecture.puml`

**Step 1: Create the PlantUML file with package structure and components**

```plantuml
@startuml Wukong Bot Architecture

' Style settings
skinparam componentStyle rectangle
skinparam packageStyle rectangle
skinparam backgroundColor #FEFEFE
skinparam arrowColor #222222
skinparam component {
    BackgroundColor #E8F4FC
    BorderColor #3498DB
}
skinparam database {
    BackgroundColor #FFF3E0
    BorderColor #E67E22
}

title Wukong Bot - High Level Architecture

package "Wukong Bot" {

    [Main\n(Entry Point)] as Main

    package "Communication Layer" {
        [Lark\n(飞书 API)] as Lark
        [Gateway\n(Message Router)] as Gateway
    }

    package "Middleware Layer" {
        [Middleware\n(Session/Dedupe/Context)] as Middleware
    }

    package "Task Layer" {
        [Queue\n(Task Queue)] as Queue
        [Worker\n(Execution Engine)] as Worker
    }

    package "Execution Layer" {
        [Agent\n(Claude CLI)] as Agent
        [Skills\n(Skill Registry)] as Skills
        [Session\n(Memory)] as Session
        [Stats\n(Daily Stats)] as Stats
        [Workflow\n(Workflow Engine)] as Workflow
    }

    package "Metacognition Layer" {
        [Reflection\n(Reflection Engine)] as Reflection
        [Evolution\n(Evolution Engine)] as Evolution
    }

    package "Infrastructure" {
        database "DB\n(SQLite)" as DB
    }
}

' Data flow - main path
Lark <--> Gateway
Gateway --> Main
Main --> Middleware
Middleware --> Queue
Queue --> Worker
Worker --> Agent
Worker --> Skills
Worker --> Session
Worker --> Stats
Worker --> Workflow

' Metacognition flow
Worker --> Reflection
Worker --> Evolution

' Database connections
Main --> DB
Agent --> DB
Skills --> DB
Session --> DB
Stats --> DB
Workflow --> DB
Reflection --> DB
Evolution --> DB

' Notes
note right of Lark
  Receives and sends
  messages from/to
  Feishu users
end note

note left of Worker
  Core metacognitive loop:
  1. Orient
  2. Act
  3. Reflect
end note

note bottom of DB
  Stores:
  - Tasks
  - Sessions
  - Memories
  - Stats
  - Config
end note

@enduml
```

**Step 2: Verify the PlantUML file exists and is complete**

Run: `cat architecture.puml | head -20`
Expected: Should show the @startuml and package structure

**Step 3: Commit the file**

```bash
cd /Users/bytedance/mxg/go/src/code.byted.org/wukong-bot
git add architecture.puml
git add docs/plans/2026-03-04-architecture-plantuml-design.md
git add docs/plans/2026-03-04-architecture-plantuml-implementation.md
git commit -m "feat: add architecture PlantUML diagram"
```

---

## Plan Complete

The architecture.puml file will contain:
- All major modules/components
- Clear dependency relationships
- Data flow arrows
- Package organization by layer
- Notes explaining key components
