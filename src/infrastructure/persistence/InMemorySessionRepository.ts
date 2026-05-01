import type { Session } from "../../domain/entities/Session.js";
import type { SessionRepository } from "../../application/ports/SessionRepository.js";

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();
  private readonly activeSessionByGuild = new Map<string, string>();

  async findActiveByGuildId(guildId: string): Promise<Session | null> {
    const sessionId = this.activeSessionByGuild.get(guildId);
    if (!sessionId) {
      return null;
    }

    return this.sessions.get(sessionId) ?? null;
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);

    if (session.phase === "archived") {
      this.activeSessionByGuild.delete(session.guildId);
      return;
    }

    this.activeSessionByGuild.set(session.guildId, session.id);
  }

  async archive(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.phase = "archived";
    this.activeSessionByGuild.delete(session.guildId);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.activeSessionByGuild.delete(session.guildId);
    this.sessions.delete(sessionId);
  }
}
