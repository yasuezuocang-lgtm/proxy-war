import { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
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
    private readonly stateMachine: SessionStateMachine
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
      // TODO: テスト用の一時設定。本番戻しは maxTurns を既定 (10) に、
      // maxAppeals を用途に応じて調整すること。
      policy: new SessionPolicy({
        maxTurns: 4, // 往復2 (A→B→A→B)
        maxAppeals: 2, // district → high → supreme の上告チェーンを検証可能に
      }),
    });

    this.stateMachine.startInput(session, input.side);
    await this.sessionRepository.save(session);

    return { session, created: true };
  }
}
