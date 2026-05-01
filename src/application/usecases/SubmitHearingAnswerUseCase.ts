import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantResponseGateway } from "../ports/ParticipantResponseGateway.js";
import type {
  DebateAgents,
  HearingAnswerReview,
} from "../ports/ParticipantAgent.js";
import { asOwnBrief } from "../ports/ParticipantAgent.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { Session } from "../../domain/entities/Session.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { DomainError } from "../../domain/errors/DomainError.js";

export interface SubmitHearingAnswerInput {
  sessionId: string;
  side: ParticipantSide;
  hearingCount: { A: number; B: number };
  question: string;
  reason: string;
}

// ヒアリングサイクル全体を担う UseCase。
// 司会から HEARING 発火を受け取って:
//   1. requestHearing で session を hearing に遷移
//   2. 依頼人へDM送信 → 回答待ち
//   3. 回答が浅ければ追撃（最大 maxHearingFollowups 回）
//   4. resolveHearing で debating に戻し、当該側の hearingCount を +1 して返す
// 追撃中も answer は agent.absorbHearingAnswer で武器リスト・brief に統合される。
export class SubmitHearingAnswerUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly messageGateway: MessageGateway,
    private readonly participantResponseGateway: ParticipantResponseGateway,
    private readonly participantAgents: DebateAgents,
    private readonly maxHearingFollowups: number
  ) {}

  async execute(
    input: SubmitHearingAnswerInput
  ): Promise<{ A: number; B: number }> {
    const session = await this.requireSession(input.sessionId);
    const request: HearingRequest = {
      requestedBy: input.side,
      targetSide: input.side,
      question: input.question,
      context: session.getCurrentRound().turns.at(-1)?.message || "",
      createdAt: Date.now(),
      answeredAt: null,
      answer: null,
    };

    this.stateMachine.requestHearing(session, request);
    await this.sessionRepository.save(session);

    await this.messageGateway.sendTalkMessage(
      `⏸️ ヒアリングタイム — ${input.side}側の依頼人に確認中...`
    );

    // 初回の質問 → 回答 → 追撃ループ。
    // 追撃（H2）は「回答が浅い時のみ」最大 maxHearingFollowups 回まで繰り返す。
    // タイムアウト時は追撃せず対話再開（ユーザーが離席している可能性が高い）。
    let currentQuestion = input.question;
    let currentReason = input.reason;
    let lastAnswer: string | null = null;
    let followupsUsed = 0;

    while (true) {
      await this.sendHearingDm(input.side, currentQuestion, currentReason);

      const answer = await this.participantResponseGateway.waitForResponse(
        input.side,
        session.policy.hearingTimeoutMs
      );

      if (!answer) {
        lastAnswer = null;
        break;
      }

      await this.updateParticipantBrief(input.sessionId, input.side, answer);
      lastAnswer = answer;

      if (followupsUsed >= this.maxHearingFollowups) {
        break;
      }

      const review = await this.reviewHearingAnswerForSide(
        input.sessionId,
        input.side,
        currentQuestion,
        answer
      );
      if (review.type === "sufficient") {
        break;
      }

      followupsUsed += 1;
      currentQuestion = review.question;
      currentReason = review.reason;
      await this.messageGateway.sendTalkMessage(
        `🔁 ${input.side}側に追撃質問（${followupsUsed}/${this.maxHearingFollowups}）...`
      );
    }

    if (lastAnswer) {
      await this.messageGateway.sendTalkMessage(
        "▶️ ヒアリング完了 — 対話再開"
      );
    } else {
      await this.messageGateway.sendTalkMessage(
        "▶️ タイムアウト — 対話再開"
      );
    }

    const latestSession = await this.requireSession(input.sessionId);
    this.stateMachine.resolveHearing(latestSession, lastAnswer ?? undefined);
    await this.sessionRepository.save(latestSession);

    const updatedCount = { ...input.hearingCount };
    updatedCount[input.side] += 1;
    return updatedCount;
  }

  private sendHearingDm(
    side: ParticipantSide,
    question: string,
    reason: string
  ): Promise<void> {
    // 依頼人には「なぜ聞くか」を質問本文と一緒に見せる。
    // reason が空文字列の場合は理由ブロックを省略（抽象フォールバックで
    // 質問だけが埋まるケースを想定）。
    const reasonBlock = reason.trim()
      ? `\n\n【確認したい理由】\n${reason.trim()}`
      : "";
    const body = `⏸️ 対話中に確認したいことが出た。\n\n${question}${reasonBlock}\n\n返信して。終わったら対話再開する。`;
    return side === "A"
      ? this.messageGateway.sendDmToA(body)
      : this.messageGateway.sendDmToB(body);
  }

  private async reviewHearingAnswerForSide(
    sessionId: string,
    side: ParticipantSide,
    question: string,
    answer: string
  ): Promise<HearingAnswerReview> {
    const session = await this.requireSession(sessionId);
    const memory = session.getAgentMemory(side);
    const currentStructuredContext = memory.privateBrief || "";

    if (side === "A") {
      return this.participantAgents.A.reviewHearingAnswer({
        sessionId,
        currentStructuredContext: asOwnBrief("A", currentStructuredContext),
        question,
        answer,
      });
    }
    return this.participantAgents.B.reviewHearingAnswer({
      sessionId,
      currentStructuredContext: asOwnBrief("B", currentStructuredContext),
      question,
      answer,
    });
  }

  private async updateParticipantBrief(
    sessionId: string,
    side: ParticipantSide,
    answer: string
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    const memory = session.getAgentMemory(side);
    const currentStructuredContext = memory.privateBrief;
    if (!currentStructuredContext) {
      return;
    }

    // absorbHearingAnswer は Promise<void>。
    // agent は内部で武器リストへの追記 + brief 統合 + stash を行う。
    // 司会側はあとで getLastBrief() で統合 brief を取り出して
    // session.agentMemoryX を更新する（司法に渡すのは session 由来のため）。
    await this.absorbHearingAnswerForSide(side, {
      sessionId,
      structuredContext: currentStructuredContext,
      answer,
    });

    const stashed = this.getLastBriefForSide(sessionId, side);
    if (!stashed) {
      // agent が stash に失敗した場合（通常フローでは起きない）。
      // privateBrief を書き換えられないが、agent 側の記憶は更新済みなので
      // 続行して次ターンへ進める。
      memory.rawInputs.push(answer);
      await this.sessionRepository.save(session);
      return;
    }

    memory.rawInputs.push(answer);
    this.assignPrivateBrief(session, side, stashed.structuredContext);
    memory.briefSummary = stashed.summary;
    await this.sessionRepository.save(session);
  }

  // privateBrief は OwnBrief<Side> ブランド付き。string をそのまま代入できないので
  // side 値で型 narrow して asOwnBrief を経由させる（ブランド型衛生のための小ヘルパー）。
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

  private absorbHearingAnswerForSide(
    side: ParticipantSide,
    params: {
      sessionId: string;
      structuredContext: string;
      answer: string;
    }
  ): Promise<void> {
    if (side === "A") {
      return this.participantAgents.A.absorbHearingAnswer({
        sessionId: params.sessionId,
        currentStructuredContext: asOwnBrief("A", params.structuredContext),
        answer: params.answer,
      });
    }
    return this.participantAgents.B.absorbHearingAnswer({
      sessionId: params.sessionId,
      currentStructuredContext: asOwnBrief("B", params.structuredContext),
      answer: params.answer,
    });
  }

  private getLastBriefForSide(sessionId: string, side: ParticipantSide) {
    if (side === "A") {
      return this.participantAgents.A.getLastBrief(sessionId);
    }
    return this.participantAgents.B.getLastBrief(sessionId);
  }

  private async requireSession(sessionId: string) {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }
    return session;
  }
}
