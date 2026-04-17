import { DomainError } from "../../domain/errors/DomainError.js";
import type { Session } from "../../domain/entities/Session.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";

export class SessionStateMachine {
  startInput(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);

    const participant = session.getParticipant(side);
    if (participant.phase === "waiting") {
      participant.phase = "inputting";
    }
  }

  moveToConfirming(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["inputting", "confirming"]);
    participant.phase = "confirming";
  }

  moveToGoalSetting(session: Session, side: ParticipantSide): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["confirming"]);
    participant.phase = "goal_setting";
    participant.brief.confirmedAt = Date.now();
  }

  markParticipantReady(session: Session, side: ParticipantSide, goal?: string): void {
    this.assertSessionPhase(session, ["preparing"]);
    const participant = session.getParticipant(side);
    this.assertParticipantPhase(participant.phase, ["goal_setting"]);
    participant.brief.goal = goal?.trim() || null;
    participant.phase = "ready";

    if (this.areAllParticipantsReady(session)) {
      session.phase = "ready";
    }
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
  }

  requestHearing(session: Session, hearing: HearingRequest): void {
    this.assertSessionPhase(session, ["debating"]);
    session.activeHearing = hearing;
    session.getCurrentRound().hearings.push(hearing);
    session.phase = "hearing";
  }

  resolveHearing(session: Session, answer?: string): void {
    this.assertSessionPhase(session, ["hearing"]);
    if (session.activeHearing) {
      session.activeHearing.answer = answer ?? null;
      session.activeHearing.answeredAt = Date.now();
    }
    session.activeHearing = null;
    session.phase = "debating";
  }

  finishRound(session: Session): void {
    this.assertSessionPhase(session, ["debating"]);
    session.phase = "judging";
  }

  // 判定完了。勝敗確定・引き分け問わず、上告枠が残っていれば appeal_pending に遷移させ
  // ユーザーが「異議あり」を出す余地を残す。
  // - 勝敗あり: 敗者のみ上告できる
  // - 引き分け: 双方から上告できる
  // - 上告枠なし: そのまま finished
  completeJudging(session: Session, judgment: Judgment): void {
    this.assertSessionPhase(session, ["judging"]);
    session.setJudgment(judgment);

    const hasAppealRoom = session.rounds.length - 1 < session.policy.maxAppeals;
    if (!hasAppealRoom) {
      session.appealableSides = [];
      session.phase = "finished";
      return;
    }

    if (judgment.winner === "draw") {
      session.appealableSides = ["A", "B"];
    } else {
      session.appealableSides = [judgment.winner === "A" ? "B" : "A"];
    }
    session.phase = "appeal_pending";
  }

  expireAppeal(session: Session): void {
    this.assertSessionPhase(session, ["appeal_pending"]);
    session.appealableSides = [];
    session.phase = "finished";
  }

  // 異議申し立てを受理し、上告審ラウンドを作って再審AIの判定フェーズへ進める。
  // 上告審では A/B 代理人の対話は行わず、前審材料のみで再評価する（user の仕様）。
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
    session.phase = "judging";
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
  }

  reset(session: Session): void {
    session.phase = "archived";
    session.activeHearing = null;
    session.appealableSides = [];
    session.participants.A.phase = "waiting";
    session.participants.B.phase = "waiting";
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
