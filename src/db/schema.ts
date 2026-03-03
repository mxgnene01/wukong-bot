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
  createdAt INTEGER NOT NULL
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
`;
