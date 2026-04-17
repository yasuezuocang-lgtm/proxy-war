import type { ParticipantPhase } from "../value-objects/ParticipantPhase.js";
import { createEmptyBrief, type Brief } from "./Brief.js";

export type ParticipantSide = "A" | "B";

export interface ParticipantParams {
  side: ParticipantSide;
  userId?: string | null;
  botId?: string | null;
}

export class Participant {
  readonly side: ParticipantSide;
  readonly userId: string | null;
  readonly botId: string | null;
  phase: ParticipantPhase;
  brief: Brief;
  followUpCount: number;

  constructor(params: ParticipantParams) {
    this.side = params.side;
    this.userId = params.userId ?? null;
    this.botId = params.botId ?? null;
    this.phase = "waiting";
    this.brief = createEmptyBrief();
    this.followUpCount = 0;
  }
}
