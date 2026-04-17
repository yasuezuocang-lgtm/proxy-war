import { DomainError } from "../errors/DomainError.js";
import { SessionPolicy } from "../policies/SessionPolicy.js";
import type { CourtLevel } from "../value-objects/CourtLevel.js";
import type { SessionPhase } from "../value-objects/SessionPhase.js";
import { DebateRound } from "./DebateRound.js";
import type { HearingRequest } from "./HearingRequest.js";
import type { Judgment } from "./Judgment.js";
import { Participant, type ParticipantSide } from "./Participant.js";

export interface SessionParams {
  id: string;
  guildId: string;
  policy?: SessionPolicy;
  createdAt?: number;
}

export class Session {
  readonly id: string;
  readonly guildId: string;
  readonly createdAt: number;
  readonly policy: SessionPolicy;
  phase: SessionPhase;
  readonly participants: Record<ParticipantSide, Participant>;
  readonly rounds: DebateRound[];
  activeHearing: HearingRequest | null;
  // 上告可能な側。勝敗がついた時は敗者のみ、引き分けの時は両側、上告終了時は空。
  appealableSides: ParticipantSide[];
  topic: string | null;

  constructor(params: SessionParams) {
    this.id = params.id;
    this.guildId = params.guildId;
    this.createdAt = params.createdAt ?? Date.now();
    this.policy = params.policy ?? new SessionPolicy();
    this.phase = "preparing";
    this.participants = {
      A: new Participant({ side: "A" }),
      B: new Participant({ side: "B" }),
    };
    this.rounds = [];
    this.activeHearing = null;
    this.appealableSides = [];
    this.topic = null;
  }

  getParticipant(side: ParticipantSide): Participant {
    return this.participants[side];
  }

  getCurrentRound(): DebateRound {
    const round = this.rounds.at(-1);
    if (!round) {
      throw new DomainError("開始中のラウンドが存在しません。");
    }
    return round;
  }

  createRound(courtLevel: CourtLevel): DebateRound {
    const round = new DebateRound({
      id: `${this.id}-round-${this.rounds.length + 1}`,
      courtLevel,
      createdAt: Date.now(),
    });
    this.rounds.push(round);
    return round;
  }

  setJudgment(judgment: Judgment): void {
    this.getCurrentRound().judgment = judgment;
  }
}
