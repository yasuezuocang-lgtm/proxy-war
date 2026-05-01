import type { Session } from "../../domain/entities/Session.js";

export interface SessionRepository {
  findActiveByGuildId(guildId: string): Promise<Session | null>;
  findById(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  archive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
