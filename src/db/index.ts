import { Database } from 'bun:sqlite';
import { schema } from './schema';
import type { Session, Setting, PendingTask, ScheduledTask, QueueTask, TaskStatus, ChatContext, HistoryMessage, AgentMessage } from '../types';

const DB_PATH = process.env.DB_PATH || './data/cody.db';

export class CodyDB {
  private db: Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init() {
    this.db.exec(schema);
    
    // 简单的迁移逻辑：检查 claudeSessionId 列是否存在，不存在则添加
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(sessions)").all() as any[];
      const hasColumn = tableInfo.some(col => col.name === 'claudeSessionId');
      if (!hasColumn) {
        console.log('[DB] Adding claudeSessionId column to sessions table');
        this.db.exec('ALTER TABLE sessions ADD COLUMN claudeSessionId TEXT');
      }
    } catch (e) {
      console.error('[DB] Failed to migrate sessions table:', e);
    }
    
    // 迁移 agent_messages 表
    try {
        this.db.exec(`
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
        `);
    } catch (e) {
      console.error('[DB] Failed to create agent_messages table:', e);
    }

    // 迁移 pending_tasks 表
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(pending_tasks)").all() as any[];
      const hasSessionKey = tableInfo.some(col => col.name === 'sessionKey');
      if (!hasSessionKey) {
        console.log('[DB] Adding sessionKey column to pending_tasks table');
        this.db.exec('ALTER TABLE pending_tasks ADD COLUMN sessionKey TEXT');
      }
      const hasAgentId = tableInfo.some(col => col.name === 'agentId');
      if (!hasAgentId) {
        console.log('[DB] Adding agentId column to pending_tasks table');
        this.db.exec('ALTER TABLE pending_tasks ADD COLUMN agentId TEXT');
      }
    } catch (e) {
      console.error('[DB] Failed to migrate pending_tasks table:', e);
    }

    // 迁移 workflow_runs 表
    try {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS workflow_runs (
                run_id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                inputs TEXT NOT NULL,
                steps TEXT NOT NULL,
                triggered_by TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
            CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
        `);
    } catch (e) {
        console.error('[DB] Failed to create workflow_runs table:', e);
    }
  }

  close() {
    this.db.close();
  }

  // ============ Sessions ============
  getSession(sessionId: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE sessionId = ?');
    const row = stmt.get(sessionId) as any;
    if (!row) return null;
    return {
      ...row,
      history: JSON.parse(row.history),
    };
  }

  saveSession(session: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Session {
    const now = Date.now();
    const existing = this.getSession(session.sessionId);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE sessions
        SET history = ?, claudeSessionId = ?, updatedAt = ?
        WHERE sessionId = ?
      `);
      stmt.run(JSON.stringify(session.history), session.claudeSessionId || null, now, session.sessionId);
      return { ...existing, ...session, updatedAt: now };
    } else {
      const id = crypto.randomUUID();
      const stmt = this.db.prepare(`
        INSERT INTO sessions (id, sessionId, claudeSessionId, chatType, userId, chatId, threadId, history, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        session.sessionId,
        session.claudeSessionId || null,
        session.chatType,
        session.userId,
        session.chatId || null,
        session.threadId || null,
        JSON.stringify(session.history),
        now,
        now
      );
      return { ...session, id, createdAt: now, updatedAt: now };
    }
  }

  appendHistory(sessionId: string, message: HistoryMessage) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const history: HistoryMessage[] = Array.isArray(session.history) ? session.history : [];
    history.push(message);
    if (history.length > 100) {
      history.shift();
    }

    this.saveSession({ ...session, history });
  }

  // ============ Settings ============
  getSetting(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as any;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string) {
    const now = Date.now();
    const existing = this.getSetting(key);

    if (existing !== null) {
      const stmt = this.db.prepare('UPDATE settings SET value = ?, updatedAt = ? WHERE key = ?');
      stmt.run(value, now, key);
    } else {
      const stmt = this.db.prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)');
      stmt.run(key, value, now);
    }
  }

  // ============ Pending Tasks ============
  createPendingTask(taskId: string, task: QueueTask, status: TaskStatus = 'pending'): PendingTask {
    const id = crypto.randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO pending_tasks (id, taskId, task, status, createdAt, sessionKey, agentId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, taskId, JSON.stringify(task), status, now, task.sessionKey || null, task.agentId || null);
    return { id, taskId, task, status, createdAt: now, sessionKey: task.sessionKey, agentId: task.agentId };
  }

  getPendingTask(taskId: string): PendingTask | null {
    const stmt = this.db.prepare('SELECT * FROM pending_tasks WHERE taskId = ?');
    const row = stmt.get(taskId) as any;
    if (!row) return null;
    return {
      ...row,
      task: JSON.parse(row.task),
    };
  }

  updatePendingTaskStatus(taskId: string, status: TaskStatus, workerId?: string) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pending_tasks
      SET status = ?, workerId = COALESCE(?, workerId), lastHeartbeatAt = ?,
          startedAt = CASE WHEN status = 'processing' AND startedAt IS NULL THEN ? ELSE startedAt END
      WHERE taskId = ?
    `);
    stmt.run(status, workerId || null, now, now, taskId);
  }

  heartbeat(taskId: string) {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE pending_tasks SET lastHeartbeatAt = ? WHERE taskId = ?');
    stmt.run(now, taskId);
  }

  removePendingTask(taskId: string) {
    const stmt = this.db.prepare('DELETE FROM pending_tasks WHERE taskId = ?');
    stmt.run(taskId);
  }

  getStuckTasks(timeoutMs: number = 300000): PendingTask[] {
    const threshold = Date.now() - timeoutMs;
    const stmt = this.db.prepare(`
      SELECT * FROM pending_tasks
      WHERE status = 'processing' AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < ?)
    `);
    const rows = stmt.all(threshold) as any[];
    return rows.map(row => ({ ...row, task: JSON.parse(row.task) }));
  }

  getPendingTasks(status?: TaskStatus): PendingTask[] {
    let query = 'SELECT * FROM pending_tasks';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY createdAt ASC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({ ...row, task: JSON.parse(row.task) }));
  }

  // ============ Scheduled Tasks ============
  createScheduledTask(
    name: string,
    cron: string,
    context: ChatContext,
    content: string
  ): ScheduledTask {
    const id = crypto.randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO scheduled_tasks (id, name, cron, context, content, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    stmt.run(id, name, cron, JSON.stringify(context), content, now, now);
    return { id, name, cron, context, content, enabled: true, createdAt: now, updatedAt: now };
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      ...row,
      context: JSON.parse(row.context),
      enabled: Boolean(row.enabled),
    };
  }

  getScheduledTasks(enabledOnly: boolean = true): ScheduledTask[] {
    let query = 'SELECT * FROM scheduled_tasks';
    const params: any[] = [];

    if (enabledOnly) {
      query += ' WHERE enabled = 1';
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      ...row,
      context: JSON.parse(row.context),
      enabled: Boolean(row.enabled),
    }));
  }

  updateScheduledTaskEnabled(id: string, enabled: boolean) {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE scheduled_tasks SET enabled = ?, updatedAt = ? WHERE id = ?');
    stmt.run(enabled ? 1 : 0, now, id);
  }

  deleteScheduledTask(id: string) {
    const stmt = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
    stmt.run(id);
  }

  // ============ Agent Messages ============

  sendAgentMessage(
    params: {
        fromSession: string;
        toSession: string;
        message: string;
        messageType?: AgentMessage['messageType'];
        correlationId?: string;
        metadata?: Record<string, unknown>;
        expiresInMs?: number;
    }
  ): number {
    const { fromSession, toSession, message, messageType = 'text', correlationId, metadata, expiresInMs } = params;
    const createdAt = Date.now();
    const expiresAt = expiresInMs ? createdAt + expiresInMs : null;

    const stmt = this.db.prepare(`
      INSERT INTO agent_messages (from_session, to_session, message, message_type, correlation_id, status, metadata, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    const result = stmt.run(
      fromSession,
      toSession,
      message,
      messageType,
      correlationId || null,
      metadata ? JSON.stringify(metadata) : null,
      createdAt,
      expiresAt,
    );

    return result.lastInsertRowid as number;
  }

  readAgentMessages(sessionKey: string, limit = 20): AgentMessage[] {
    const now = Date.now();
    // 1. 清理过期消息
    this.db.prepare(`
      UPDATE agent_messages SET status = 'expired'
      WHERE to_session = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?
    `).run(sessionKey, now);

    // 2. 读取未读消息
    const stmt = this.db.prepare(`
      SELECT * FROM agent_messages
      WHERE to_session = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(sessionKey, limit) as any[];

    if (rows.length === 0) return [];

    const messages = rows.map(row => ({
      id: row.id,
      fromSession: row.from_session,
      toSession: row.to_session,
      message: row.message,
      messageType: row.message_type,
      correlationId: row.correlation_id,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: new Date(row.created_at).toISOString(),
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    }));

    // 3. 标记为已读
    const ids = rows.map(r => r.id).join(',');
    this.db.prepare(`
      UPDATE agent_messages SET status = 'read', read_at = ?
      WHERE id IN (${ids})
    `).run(now);

    return messages;
  }

  async waitForReply(
    sessionKey: string,
    correlationId: string,
    timeoutMs = 120000,
    pollIntervalMs = 1000
  ): Promise<AgentMessage | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const stmt = this.db.prepare(`
        SELECT * FROM agent_messages
        WHERE to_session = ? AND correlation_id = ? AND status = 'pending'
        LIMIT 1
      `);
      const row = stmt.get(sessionKey, correlationId) as any;

      if (row) {
        // 标记为已读
        this.db.prepare(`
          UPDATE agent_messages SET status = 'read', read_at = ?
          WHERE id = ?
        `).run(Date.now(), row.id);

        return {
          id: row.id,
          fromSession: row.from_session,
          toSession: row.to_session,
          message: row.message,
          messageType: row.message_type,
          correlationId: row.correlation_id,
          status: row.status,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          createdAt: new Date(row.created_at).toISOString(),
          readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
          expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        };
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return null;
  }
}

let dbInstance: CodyDB | null = null;

export function getDB(): CodyDB {
  if (!dbInstance) {
    dbInstance = new CodyDB();
  }
  return dbInstance;
}
