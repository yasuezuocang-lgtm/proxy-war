import { DomainError } from "../../domain/errors/DomainError.js";
import type { Session } from "../../domain/entities/Session.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";
import type {
  TransitionEvent,
  TransitionListener,
} from "./GuidanceMessages.js";

// 上告可能時間（APPEAL_WINDOW_MS）が経過して
// appeal_pending → finished に遷移した事実を呼び出し側が観測できるようにする
// ドメインイベント。DebateCoordinator がこれを受けて #talk への告知や
// 以後の上告ループ打ち切りに使う。
export interface AppealExpiredEvent {
  readonly type: "AppealExpired";
  readonly sessionId: string;
  readonly closedAtCourtLevel: CourtLevel;
  readonly expiredAt: number;
}

export class SessionStateMachine {
  // 各遷移時に TransitionEvent を emit して、
  // GuidanceMessages.guidanceFor() で案内文に変換させる。
  // listener 未指定ならイベントは黙って捨てる（既存呼び出し側との互換）。
  constructor(private readonly listener?: TransitionListener) {}

  private emit(event: TransitionEvent): void {
    this.listener?.(event);
  }

  // 全ての遷移で lastActivityAt を更新する。
  // SessionTimeoutChecker はこの値を now() と比較して 24 時間無応答のセッションを
  // 自動アーカイブする。
  private touch(session: Session): void {
    session.lastActivityAt = Date.now();
  }

  startInput(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);

    const participant = session.getParticipant(side);
    if (participant.phase === "waiting") {
      participant.phase = "inputting";
    }
    this.touch(session);
  }

  moveToConfirming(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["inputting", "confirming"]);
    participant.phase = "confirming";
    this.touch(session);
    this.emit({ type: "moved_to_confirming", side });
  }

  moveToGoalSetting(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["confirming"]);
    participant.phase = "goal_setting";
    session.getAgentMemory(side).confirmedAt = Date.now();
    this.touch(session);
    this.emit({ type: "moved_to_goal_setting", side });
  }

  markParticipantReady(session: Session, side: ParticipantSide, goal?: string): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["goal_setting"]);
    session.getAgentMemory(side).publicGoal = goal?.trim() || null;
    participant.phase = "ready";

    const sessionReady = this.areAllParticipantsReady(session);
    if (sessionReady) {
      session.phase = "ready";
    }
    this.touch(session);
    this.emit({ type: "participant_ready", side, sessionReady });
  }

  startDebate(session: Session, courtLevel: CourtLevel): void {
    this.assertSessionPhase(session, ["ready", "appeal_pending"]);
    if (!this.areAllParticipantsReady(session)) {
      throw new DomainError("両参加者の準備が完了していません。");
    }

    session.createRound(courtLevel);
    session.phase = "debating";
    session.activeHearing = null;
    session.appealableSides = [];
    this.touch(session);
    this.emit({ type: "debate_started", courtLevel });
  }

  requestHearing(session: Session, hearing: HearingRequest): void {
    this.assertSessionPhase(session, ["debating"]);
    session.activeHearing = hearing;
    session.getCurrentRound().hearings.push(hearing);
    session.phase = "hearing";
    this.touch(session);
    this.emit({ type: "hearing_started", targetSide: hearing.targetSide });
  }

  resolveHearing(session: Session, answer?: string): void {
    this.assertSessionPhase(session, ["hearing"]);
    const hearing = session.activeHearing;
    if (hearing) {
      hearing.answer = answer ?? null;
      hearing.answeredAt = Date.now();
    }
    session.activeHearing = null;
    session.phase = "debating";
    this.touch(session);
    if (hearing) {
      this.emit({ type: "hearing_resolved", targetSide: hearing.targetSide });
    }
  }

  finishRound(session: Session): void {
    this.assertSessionPhase(session, ["debating"]);
    session.phase = "judging";
    this.touch(session);
    this.emit({ type: "round_finished" });
  }

  // 判定完了。勝敗確定・引き分け問わず、上告枠が残っていれば appeal_pending に遷移させ
  // ユーザーが「異議あり」を出す余地を残す。
  // - 勝敗あり: 敗者のみ上告できる
  // - 引き分け: 双方から上告できる
  // - 上告枠なし: そのまま finished
  completeJudging(session: Session, judgment: Judgment): void {
    this.assertSessionPhase(session, ["judging"]);
    session.setJudgment(judgment);
    const courtLevel = session.getCurrentRound().courtLevel;

    const hasAppealRoom = session.rounds.length - 1 < session.policy.maxAppeals;
    if (!hasAppealRoom) {
      session.appealableSides = [];
      session.phase = "finished";
      this.touch(session);
      this.emit({
        type: "judging_completed",
        phase: "finished",
        winner: judgment.winner,
        courtLevel,
        appealableSides: [],
      });
      return;
    }

    if (judgment.winner === "draw") {
      session.appealableSides = ["A", "B"];
    } else {
      session.appealableSides = [judgment.winner === "A" ? "B" : "A"];
    }
    session.phase = "appeal_pending";
    this.touch(session);
    this.emit({
      type: "judging_completed",
      phase: "appeal_pending",
      winner: judgment.winner,
      courtLevel,
      appealableSides: [...session.appealableSides],
    });
  }

  // 上告可能時間（APPEAL_WINDOW_MS）が経過した時に呼ばれる。
  // appeal_pending → finished に遷移し、AppealExpired イベントを返す。
  // タイマー駆動側（DebateCoordinator.handleAppealCycle）は戻り値を観測して
  // #talk の告知や上告ループ終了を判断する。
  expireAppeal(session: Session): AppealExpiredEvent {
    this.assertSessionPhase(session, ["appeal_pending"]);
    const closedAtCourtLevel = session.getCurrentRound().courtLevel;
    session.appealableSides = [];
    session.phase = "finished";
    this.touch(session);
    this.emit({ type: "appeal_expired", closedAtCourtLevel });
    return {
      type: "AppealExpired",
      sessionId: session.id,
      closedAtCourtLevel,
      expiredAt: Date.now(),
    };
  }

  // 異議申し立てを受理して次審級の判定フェーズへ進める。
  // ※ 仕様としては「debating で再対話」だが、
  //    DebateCoordinator 側の上告サイクル処理が未追従のため一時的に judging のまま据え置く。
  //    完全実装は将来対応（debating 遷移＋次審で再対話）。
  acceptAppeal(session: Session, appeal: Appeal): void {
    this.assertSessionPhase(session, ["appeal_pending"]);

    if (session.appealableSides.length === 0) {
      throw new DomainError("異議を申し立てられる状態ではありません。");
    }
    if (!session.appealableSides.includes(appeal.appellantSide)) {
      throw new DomainError("異議申し立ての権限がない側です。");
    }

    const nextLevel = this.nextCourtLevel(session);
    const round = session.createRound(nextLevel);
    round.appeal = appeal;
    session.appealableSides = [];
    session.activeHearing = null;
    session.phase = "judging";
    this.touch(session);
    this.emit({
      type: "appeal_accepted",
      appellantSide: appeal.appellantSide,
      nextCourtLevel: nextLevel,
    });
  }

  private nextCourtLevel(session: Session): CourtLevel {
    const current = session.rounds.at(-1)?.courtLevel;
    if (current === "district") {
      return "high";
    }
    if (current === "high") {
      return "supreme";
    }
    throw new DomainError("これ以上の上告はできません。");
  }

  archive(session: Session): void {
    this.assertSessionPhase(session, ["finished"]);
    session.phase = "archived";
    this.touch(session);
    this.emit({ type: "archived" });
  }

  reset(session: Session): void {
    session.phase = "archived";
    session.activeHearing = null;
    session.appealableSides = [];
    session.participants.A.phase = "waiting";
    session.participants.B.phase = "waiting";
    this.touch(session);
    this.emit({ type: "reset" });
  }

  private areAllParticipantsReady(session: Session): boolean {
    return Object.values(session.participants).every(
      (participant) => participant.phase === "ready"
    );
  }

  private assertSessionPhase(
    session: Session,
    allowedPhases: readonly Session["phase"][]
  ): void {
    if (allowedPhases.includes(session.phase)) {
      return;
    }

    throw new DomainError(
      `許可されていないセッション状態です: ${session.phase}`
    );
  }

  private assertParticipantPhase(
    actualPhase: Session["participants"]["A"]["phase"],
    allowedPhases: readonly Session["participants"]["A"]["phase"][]
  ): void {
    if (allowedPhases.includes(actualPhase)) {
      return;
    }

    throw new DomainError(
      `許可されていない参加者状態です: ${actualPhase}`
    );
  }
}
