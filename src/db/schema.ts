export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sessionId TEXT UNIQUE NOT NULL,
    claudeSessionId TEXT,
    chatType TEXT NOT NULL,
    userId TEXT NOT NULL,
    chatId TEXT,
    threadId TEXT,
    history TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_sessions_sessionId ON sessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
CREATE INDEX IF NOT EXISTS idx_sessions_chatId ON sessions(chatId);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_tasks (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL UNIQUE,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  workerId TEXT,
  startedAt INTEGER,
  lastHeartbeatAt INTEGER,
  createdAt INTEGER NOT NULL,
  sessionKey TEXT,
  agentId TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_tasks_status ON pending_tasks(status);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_workerId ON pending_tasks(workerId);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_createdAt ON pending_tasks(createdAt);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  context TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  correlation_id TEXT,
  status TEXT DEFAULT 'pending',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to_session ON agent_messages(to_session, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_correlation ON agent_messages(correlation_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  inputs TEXT NOT NULL,             -- JSON
  steps TEXT NOT NULL,              -- JSON，所有步骤的状态
  triggered_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;
