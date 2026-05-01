import { DomainError } from "../errors/DomainError.js";
import { SessionPolicy } from "../policies/SessionPolicy.js";
import type { CourtLevel } from "../value-objects/CourtLevel.js";
import type { SessionPhase } from "../value-objects/SessionPhase.js";
import { AgentMemory } from "./AgentMemory.js";
import { DebateRound } from "./DebateRound.js";
import type { HearingRequest } from "./HearingRequest.js";
import type { Judgment } from "./Judgment.js";
import { Participant, type ParticipantSide } from "./Participant.js";

export interface SessionParams {
  id: string;
  guildId: string;
  policy?: SessionPolicy;
  createdAt?: number;
  lastActivityAt?: number;
}

export class Session {
  readonly id: string;
  readonly guildId: string;
  readonly createdAt: number;
  readonly policy: SessionPolicy;
  phase: SessionPhase;
  readonly participants: Record<ParticipantSide, Participant>;
  // A 側・B 側の代理人記憶を別インスタンスで保持する。
  // 各 AgentMemory は OwnBrief<Side> でブランド付けされ、
  // 反対側の memory への参照や代入が型レベルで弾かれる。
  readonly agentMemoryA: AgentMemory<"A">;
  readonly agentMemoryB: AgentMemory<"B">;
  readonly rounds: DebateRound[];
  activeHearing: HearingRequest | null;
  // 上告可能な側。勝敗がついた時は敗者のみ、引き分けの時は両側、上告終了時は空。
  appealableSides: ParticipantSide[];
  topic: string | null;
  // 最後にセッションで何らかの活動があった時刻（ms）。
  // SessionStateMachine の全遷移で更新される。SessionTimeoutChecker が
  // now() - lastActivityAt > SESSION_IDLE_TIMEOUT_MS を満たすセッションを
  // 自動アーカイブ対象にする。初期値は createdAt。
  lastActivityAt: number;

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
    this.agentMemoryA = new AgentMemory({ side: "A", principalId: "" });
    this.agentMemoryB = new AgentMemory({ side: "B", principalId: "" });
    this.rounds = [];
    this.activeHearing = null;
    this.appealableSides = [];
    this.topic = null;
    this.lastActivityAt = params.lastActivityAt ?? this.createdAt;
  }

  getParticipant(side: ParticipantSide): Participant {
    return this.participants[side];
  }

  // side で型 narrow した AgentMemory を取り出す。
  // overload により呼び出し側で AgentMemory<"A"> / AgentMemory<"B"> として静的解決される。
  // 引数が generic の場合は union 戻り値になるため、呼び出し側で side === "A" 分岐を取るか
  // agentMemoryA / agentMemoryB を直接参照する。
  getAgentMemory(side: "A"): AgentMemory<"A">;
  getAgentMemory(side: "B"): AgentMemory<"B">;
  getAgentMemory(
    side: ParticipantSide
  ): AgentMemory<"A"> | AgentMemory<"B">;
  getAgentMemory(
    side: ParticipantSide
  ): AgentMemory<"A"> | AgentMemory<"B"> {
    return side === "A" ? this.agentMemoryA : this.agentMemoryB;
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
