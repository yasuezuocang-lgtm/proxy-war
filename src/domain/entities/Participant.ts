import type { ParticipantPhase } from "../value-objects/ParticipantPhase.js";

export type ParticipantSide = "A" | "B";

export interface ParticipantParams {
  side: ParticipantSide;
  userId?: string | null;
  botId?: string | null;
}

// Step 5 / migration-plan §3 Step 5:
// brief / goal は AgentMemory<Side> へ移譲し、Participant は依頼人 ID と参加者フェーズだけ持つ。
// AgentMemory への参照は Session 経由（session.agentMemoryA / agentMemoryB / getAgentMemory）。
export class Participant {
  readonly side: ParticipantSide;
  readonly userId: string | null;
  readonly botId: string | null;
  phase: ParticipantPhase;
  followUpCount: number;

  constructor(params: ParticipantParams) {
    this.side = params.side;
    this.userId = params.userId ?? null;
    this.botId = params.botId ?? null;
    this.phase = "waiting";
    this.followUpCount = 0;
  }
}
