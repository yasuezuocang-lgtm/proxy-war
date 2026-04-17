import type { CourtLevel } from "../value-objects/CourtLevel.js";
import type { Appeal } from "./Appeal.js";
import type { DebateTurn } from "./DebateTurn.js";
import type { HearingRequest } from "./HearingRequest.js";
import type { Judgment } from "./Judgment.js";

export interface DebateRoundParams {
  id: string;
  courtLevel: CourtLevel;
  createdAt: number;
}

// district = 第一審（A/B代理人が対話するラウンド）
// high / supreme = 上告審（前審の判定と異議を材料に審判AIのみが再評価する）
export class DebateRound {
  readonly id: string;
  readonly courtLevel: CourtLevel;
  readonly createdAt: number;
  turns: DebateTurn[];
  hearings: HearingRequest[];
  judgment: Judgment | null;
  appeal: Appeal | null;

  constructor(params: DebateRoundParams) {
    this.id = params.id;
    this.courtLevel = params.courtLevel;
    this.createdAt = params.createdAt;
    this.turns = [];
    this.hearings = [];
    this.judgment = null;
    this.appeal = null;
  }
}
