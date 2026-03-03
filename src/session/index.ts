import { getDB } from '../db';
import type { ChatContext, Session } from '../types';
export { SessionRecorder, getSessionRecorder } from './recorder';

export class SessionManager {
  private db = getDB();

  getOrCreateSession(context: ChatContext, agentId?: string): Session {
    // 如果指定了 agentId，生成独立的 sessionId
    const targetSessionId = agentId ? `agent:${agentId}:${context.sessionId}` : context.sessionId;
    
    const existing = this.db.getSession(targetSessionId);
    if (existing) {
      return existing;
    }

    return this.db.saveSession({
      sessionId: targetSessionId,
      claudeSessionId: undefined, // Claude Session ID 由 Claude Code CLI 返回，不是我们生成的
      chatType: context.chatType,
      userId: context.userId,
      chatId: context.chatId,
      threadId: context.threadId,
      history: [],
    });
  }

  getSession(sessionId: string): Session | null {
    return this.db.getSession(sessionId);
  }

  saveSession(session: Session): Session {
    return this.db.saveSession(session);
  }
}

let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}
