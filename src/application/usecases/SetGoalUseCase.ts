import { DomainError } from "../../domain/errors/DomainError.js";
import type { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";

export interface SetGoalInput {
  sessionId: string;
  side: ParticipantSide;
  message: string;
}

export interface SetGoalOutput {
  session: Session;
  reply: string;
  participantReady: boolean;
  sessionReady: boolean;
}

export class SetGoalUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine
  ) {}

  async execute(input: SetGoalInput): Promise<SetGoalOutput> {
    const session = await this.sessionRepository.findById(input.sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }

    const normalized = input.message.trim().toLowerCase();
    const goal = this.parseGoal(input.message);

    if (!goal && !this.isSkipWord(normalized)) {
      return {
        session,
        reply: "ゴールあれば「ゴール:○○」。なければ「なし」で。",
        participantReady: false,
        sessionReady: session.phase === "ready",
      };
    }

    this.stateMachine.markParticipantReady(session, input.side, goal ?? undefined);
    await this.sessionRepository.save(session);

    return {
      session,
      reply: session.phase === "ready" ? "#talk で始める。" : "相手待ち。",
      participantReady: true,
      sessionReady: session.phase === "ready",
    };
  }

  private parseGoal(message: string): string | null {
    const match = message.match(/^(ゴール|goal)[:：]\s*(.+)$/i);
    if (!match) {
      return null;
    }

    return match[2].trim() || null;
  }

  private isSkipWord(normalized: string): boolean {
    return ["なし", "no", "スキップ", "skip"].includes(normalized);
  }
}
