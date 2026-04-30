import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type {
  AgentTurnResult,
  DebateAgent,
  DebateAgents,
  PublicTurn,
} from "../ports/ParticipantAgent.js";
import { asOwnBrief } from "../ports/ParticipantAgent.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import { DomainError } from "../../domain/errors/DomainError.js";

export interface ProcessAgentTurnInput {
  sessionId: string;
  side: ParticipantSide;
  turnIndex: number;
  // 当該側の HEARING 使用済み回数 + 上限。
  // 司会が hearingCount を持つので、ここでは入力として受け取って
  // 「上限到達なら hearing を返さずフォールバック発言で消費」を判定する。
  hearingsUsed: number;
  maxHearings: number;
}

// 1ターン分の処理結果。
// - "message": 発言が確定して appendTurn 済み（司会はターン番号を進める）
// - "hearing": HEARING 発火、未確定。司会は SubmitHearingAnswerUseCase に渡す
export type ProcessAgentTurnResult =
  | { type: "message" }
  | { type: "hearing"; question: string; reason: string };

// 司会から1ターンの実行を委譲される UseCase。
// callAgent → 結果分岐（hearing / message）→ appendTurn まで完結。
// 「誰の手番か」「何ターン進んだか」のループ管理は司会側に残す。
export class ProcessAgentTurnUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly messageGateway: MessageGateway,
    private readonly participantAgents: DebateAgents
  ) {}

  async execute(input: ProcessAgentTurnInput): Promise<ProcessAgentTurnResult> {
    const session = await this.sessionRepository.findById(input.sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }

    const memory = session.getAgentMemory(input.side);
    const conversation: PublicTurn[] = session
      .getCurrentRound()
      .turns.map((turn) => ({
        speaker: turn.speakerSide,
        message: turn.message,
      }));

    // #talk に「誰のAIが考え中か」をテキストで通知し、
    // Discord ネイティブの入力中アニメーションも並行して送る。
    await this.messageGateway.sendTalkMessage(
      `💬 **${input.side}代理AI** — 考え中...`
    );
    await this.messageGateway.sendTalkTyping?.(input.side);

    const result = await this.callAgentForSide(input.side, {
      sessionId: input.sessionId,
      briefText: memory.privateBrief || "",
      goal: memory.publicGoal,
      conversation,
      turnIndex: input.turnIndex,
    });

    if (
      result.type === "hearing" &&
      input.hearingsUsed < input.maxHearings
    ) {
      return {
        type: "hearing",
        question: result.question,
        reason: result.reason,
      };
    }

    // hearing の上限到達 or message。どちらも appendTurn して #talk に発信。
    const message =
      result.type === "message"
        ? result.message
        : "今の反論材料だと弱い。依頼人の追加情報が必要だ。";

    await this.appendTurn(input.sessionId, input.side, message);
    await this.messageGateway.sendTalkMessage(message, input.side);
    return { type: "message" };
  }

  private async appendTurn(
    sessionId: string,
    side: ParticipantSide,
    message: string
  ): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }
    session.getCurrentRound().turns.push({
      speakerSide: side,
      message,
      createdAt: Date.now(),
    });
    await this.sessionRepository.save(session);
  }

  // 型レベルで片側の brief だけを渡せる入口。side の値によって
  // 選ばれる agent の型パラメータ S が揃うため、誤って反対側の brief
  // を混ぜるコードはコンパイルが通らない。
  private callAgentForSide(
    side: ParticipantSide,
    params: {
      sessionId: string;
      briefText: string;
      goal: string | null;
      conversation: PublicTurn[];
      turnIndex: number;
    }
  ): Promise<AgentTurnResult> {
    if (side === "A") {
      return this.callAgent("A", this.participantAgents.A, params);
    }
    return this.callAgent("B", this.participantAgents.B, params);
  }

  private callAgent<Side extends ParticipantSide>(
    side: Side,
    agent: DebateAgent<Side>,
    params: {
      sessionId: string;
      briefText: string;
      goal: string | null;
      conversation: PublicTurn[];
      turnIndex: number;
    }
  ): Promise<AgentTurnResult> {
    const turnInput = {
      sessionId: params.sessionId,
      brief: asOwnBrief(side, params.briefText),
      goal: params.goal,
      conversation: params.conversation,
      turnIndex: params.turnIndex,
    };
    if (params.turnIndex === 0) {
      return agent.generateOpeningTurn(turnInput);
    }
    return agent.generateReplyTurn(turnInput);
  }
}
