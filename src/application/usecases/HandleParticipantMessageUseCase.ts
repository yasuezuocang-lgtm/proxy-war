import { DomainError } from "../../domain/errors/DomainError.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import {
  ConfirmBriefUseCase,
  type ConfirmBriefOutput,
} from "./ConfirmBriefUseCase.js";
import {
  SetGoalUseCase,
  type SetGoalOutput,
} from "./SetGoalUseCase.js";
import {
  SubmitInputUseCase,
  type SubmitInputOutput,
} from "./SubmitInputUseCase.js";

export type ParticipantMessageResult =
  | ({
      handledBy: "submit_input";
      sessionId: string;
    } & SubmitInputOutput)
  | ({
      handledBy: "confirm_brief";
      sessionId: string;
    } & ConfirmBriefOutput)
  | ({
      handledBy: "set_goal";
      sessionId: string;
    } & SetGoalOutput)
  | {
      handledBy: "waiting";
      sessionId: string;
      reply: string;
    };

export interface HandleParticipantMessageInput {
  guildId: string;
  side: ParticipantSide;
  message: string;
}

export class HandleParticipantMessageUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly submitInputUseCase: SubmitInputUseCase,
    private readonly confirmBriefUseCase: ConfirmBriefUseCase,
    private readonly setGoalUseCase: SetGoalUseCase
  ) {}

  async execute(
    input: HandleParticipantMessageInput
  ): Promise<ParticipantMessageResult> {
    const session = await this.sessionRepository.findActiveByGuildId(input.guildId);
    if (!session) {
      const result = await this.submitInputUseCase.execute(input);
      return {
        handledBy: "submit_input",
        sessionId: result.session.id,
        ...result,
      };
    }

    const participant = session.getParticipant(input.side);

    switch (participant.phase) {
      case "waiting":
      case "inputting": {
        const result = await this.submitInputUseCase.execute(input);
        return {
          handledBy: "submit_input",
          sessionId: result.session.id,
          ...result,
        };
      }

      case "confirming": {
        const result = await this.confirmBriefUseCase.execute({
          sessionId: session.id,
          side: input.side,
          message: input.message,
        });
        return {
          handledBy: "confirm_brief",
          sessionId: result.session.id,
          ...result,
        };
      }

      case "goal_setting": {
        const result = await this.setGoalUseCase.execute({
          sessionId: session.id,
          side: input.side,
          message: input.message,
        });
        return {
          handledBy: "set_goal",
          sessionId: result.session.id,
          ...result,
        };
      }

      case "ready":
        return {
          handledBy: "waiting",
          sessionId: session.id,
          reply: session.phase === "ready" ? "#talk で始める。" : "相手待ち。",
        };

      default:
        throw new DomainError("未対応の参加者状態です。");
    }
  }
}
