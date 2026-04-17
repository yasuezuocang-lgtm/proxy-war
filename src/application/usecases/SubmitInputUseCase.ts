import type { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { BriefComposer } from "../services/BriefComposer.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { StartSessionUseCase } from "./StartSessionUseCase.js";

const MINIMUM_INPUT_LENGTH = 10;
const MAX_PROBE_COUNT = 3;

export interface SubmitInputInput {
  guildId: string;
  side: ParticipantSide;
  message: string;
}

export interface SubmitInputOutput {
  session: Session;
  reply: string;
  needsMoreInput: boolean;
  movedToConfirming: boolean;
}

export class SubmitInputUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly startSessionUseCase: StartSessionUseCase,
    private readonly stateMachine: SessionStateMachine,
    private readonly briefComposer: BriefComposer
  ) {}

  async execute(input: SubmitInputInput): Promise<SubmitInputOutput> {
    const trimmedMessage = input.message.trim();
    const { session } = await this.startSessionUseCase.execute({
      guildId: input.guildId,
      side: input.side,
    });
    const participant = session.getParticipant(input.side);

    participant.brief.rawInputs.push(trimmedMessage);

    const totalLength = participant.brief.rawInputs.join("").length;
    if (totalLength < MINIMUM_INPUT_LENGTH) {
      await this.sessionRepository.save(session);
      return {
        session,
        reply: "もうちょい教えて。何があった？",
        needsMoreInput: true,
        movedToConfirming: false,
      };
    }

    const brief = await this.composeBrief(session, input.side, trimmedMessage);
    participant.brief.structuredContext = brief.structuredContext;
    participant.brief.summary = brief.summary;

    if (
      this.briefComposer.hasSignificantGaps(brief.structuredContext) &&
      participant.followUpCount < MAX_PROBE_COUNT
    ) {
      participant.followUpCount++;
      const probe = await this.briefComposer.generateProbe(
        brief.structuredContext
      );
      await this.sessionRepository.save(session);

      return {
        session,
        reply: probe,
        needsMoreInput: true,
        movedToConfirming: false,
      };
    }

    this.stateMachine.moveToConfirming(session, input.side);
    await this.sessionRepository.save(session);

    return {
      session,
      reply: `${brief.summary}\n\nこれで戦う。「はい」で確定、違うとこあれば送って`,
      needsMoreInput: false,
      movedToConfirming: true,
    };
  }

  private async composeBrief(
    session: Session,
    side: ParticipantSide,
    additionalInput: string
  ) {
    const participant = session.getParticipant(side);
    if (!participant.brief.structuredContext) {
      return this.briefComposer.composeFromRawInputs(participant.brief.rawInputs);
    }

    return this.briefComposer.appendToBrief({
      currentStructuredContext: participant.brief.structuredContext,
      additionalInput,
    });
  }
}
