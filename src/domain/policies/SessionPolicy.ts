export interface SessionPolicyParams {
  maxTurns?: number;
  maxHearingsPerSide?: number;
  hearingTimeoutMs?: number;
  appealTimeoutMs?: number;
  maxAppeals?: number;
}

export class SessionPolicy {
  readonly maxTurns: number;
  readonly maxHearingsPerSide: number;
  readonly hearingTimeoutMs: number;
  readonly appealTimeoutMs: number;
  readonly maxAppeals: number;

  constructor(params: SessionPolicyParams = {}) {
    this.maxTurns = params.maxTurns ?? 10;
    this.maxHearingsPerSide = params.maxHearingsPerSide ?? 2;
    this.hearingTimeoutMs = params.hearingTimeoutMs ?? 5 * 60 * 1000;
    this.appealTimeoutMs = params.appealTimeoutMs ?? 5 * 60 * 1000;
    this.maxAppeals = params.maxAppeals ?? 2;
  }
}
