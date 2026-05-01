import { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { AppConfig } from "../../config.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";

export interface StartSessionInput {
  guildId: string;
  side: ParticipantSide;
}

export interface StartSessionOutput {
  session: Session;
  created: boolean;
}

export class StartSessionUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly config: AppConfig
  ) {}

  async execute(input: StartSessionInput): Promise<StartSessionOutput> {
    const existing = await this.sessionRepository.findActiveByGuildId(
      input.guildId
    );
    if (existing) {
      this.stateMachine.startInput(existing, input.side);
      await this.sessionRepository.save(existing);
      return { session: existing, created: false };
    }

    const session = new Session({
      id: `${input.guildId}-${Date.now()}`,
      guildId: input.guildId,
      policy: new SessionPolicy({
        maxTurns: this.config.debate.maxTurnsPerRound,
        maxAppeals: this.config.appeal.maxAppeals,
        maxHearingsPerSide: this.config.hearing.maxHearingsPerSide,
        hearingTimeoutMs: this.config.hearing.hearingTimeoutMs,
        appealTimeoutMs: this.config.appeal.appealWindowMs,
      }),
    });

    this.stateMachine.startInput(session, input.side);
    await this.sessionRepository.save(session);

    return { session, created: true };
  }
}
