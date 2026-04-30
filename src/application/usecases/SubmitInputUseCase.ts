import type { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { AppConfig } from "../../config.js";
import { hasSignificantGaps } from "../../domain/policies/BriefGapPolicy.js";
import { asOwnBrief } from "../ports/ParticipantAgent.js";
import type { ParticipantLlmGateway } from "../ports/LlmGateway.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { StartSessionUseCase } from "./StartSessionUseCase.js";

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
    private readonly llmGateway: ParticipantLlmGateway,
    private readonly config: AppConfig
  ) {}

  async execute(input: SubmitInputInput): Promise<SubmitInputOutput> {
    const trimmedMessage = input.message.trim();
    const { session } = await this.startSessionUseCase.execute({
      guildId: input.guildId,
      side: input.side,
    });
    const participant = session.getParticipant(input.side);
    const memory = session.getAgentMemory(input.side);

    memory.rawInputs.push(trimmedMessage);

    const totalLength = memory.rawInputs.join("").length;
    if (totalLength < this.config.input.minInputLength) {
      await this.sessionRepository.save(session);
      return {
        session,
        reply: "もうちょい教えて。何があった？",
        needsMoreInput: true,
        movedToConfirming: false,
      };
    }

    const brief = await this.composeBrief(session, input.side);
    this.assignPrivateBrief(session, input.side, brief.structuredContext);
    memory.briefSummary = brief.summary;

    if (
      hasSignificantGaps(brief.structuredContext) &&
      participant.followUpCount < this.config.input.maxProbeQuestions
    ) {
      participant.followUpCount++;
      const probe = await this.llmGateway.generateProbe({
        side: input.side,
        structuredContext: brief.structuredContext,
      });
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

  private async composeBrief(session: Session, side: ParticipantSide) {
    const memory = session.getAgentMemory(side);
    return this.llmGateway.extractBrief({
      side,
      rawInputs: memory.rawInputs,
    });
  }

  // privateBrief の OwnBrief<Side> ブランドを保つため、side 値で型 narrow した上で
  // asOwnBrief を経由して代入する。
  private assignPrivateBrief(
    session: Session,
    side: ParticipantSide,
    structuredContext: string
  ): void {
    if (side === "A") {
      session.agentMemoryA.privateBrief = asOwnBrief("A", structuredContext);
      return;
    }
    session.agentMemoryB.privateBrief = asOwnBrief("B", structuredContext);
  }
}
