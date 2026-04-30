import { DomainError } from "../../domain/errors/DomainError.js";
import {
  createAppeal,
  type Appeal,
} from "../../domain/entities/Appeal.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { Session } from "../../domain/entities/Session.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";

// 上告受理ユースケース。
//
// appeal_pending フェーズで敗者（または引き分け時の任意の側）から異議内容を受け取り、
// Appeal エンティティを生成して新しい審級ラウンドを作る。
// 受理後の遷移は SessionStateMachine.acceptAppeal に委譲する（現状は judging へ直行し、
// 上告審では A/B 代理人の対話を行わず審判 AI のみで再評価する仕様 — DebateCoordinator
// 側のコメントを参照）。
export interface AppealJudgmentInput {
  sessionId: string;
  side: ParticipantSide;
  content: string;
  now?: number;
}

export interface AppealJudgmentOutput {
  session: Session;
  appeal: Appeal;
  nextCourtLevel: CourtLevel;
}

export class AppealJudgmentUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine
  ) {}

  async execute(input: AppealJudgmentInput): Promise<AppealJudgmentOutput> {
    const session = await this.sessionRepository.findById(input.sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }

    if (session.phase !== "appeal_pending") {
      throw new DomainError(
        `上告は appeal_pending フェーズでのみ受理できます: ${session.phase}`
      );
    }

    if (!session.appealableSides.includes(input.side)) {
      throw new DomainError("異議申し立ての権限がない側です。");
    }

    const currentRound = session.getCurrentRound();
    const judgment = currentRound.judgment;
    if (!judgment) {
      throw new DomainError("前審の判定が存在しないため上告できません。");
    }

    // createAppeal() が上告ドメイン制約を全て検証する：
    // - 引き分けからの上告禁止（ただし appealableSides に乗っている時点でルートでは弾かれている）
    // - 最高裁からの上告禁止
    // - 勝者からの上告禁止
    // - 空 content の禁止
    const appeal = createAppeal({
      side: input.side,
      content: input.content,
      currentCourtLevel: currentRound.courtLevel,
      winner: judgment.winner,
      now: input.now,
    });

    this.stateMachine.acceptAppeal(session, appeal);
    await this.sessionRepository.save(session);

    return {
      session,
      appeal,
      nextCourtLevel: session.getCurrentRound().courtLevel,
    };
  }
}
