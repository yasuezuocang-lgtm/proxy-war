import type { ParticipantSide } from "./Participant.js";

// 人格プロンプト（A/B/審判 で独立した人格を表現するためのメタデータ）。
// SPEC §8.3 — 性格プロンプト。
export interface AgentPersonality {
  readonly id: string;
  readonly label: string;
  readonly promptSeed: string;
  readonly styleNotes?: string;
}

// 戦術メモの 1 エントリ。SPEC §8.3 では strategyMemo: string[] と書かれているが、
// H3（ヒアリング回答の構造化追記）で出典・時刻が必要になるため、構造化した追記型にする。
export type StrategyMemoSource =
  | "opening"
  | "reply"
  | "hearing_answer"
  | "external";

export interface StrategyMemo {
  readonly addedAt: number;
  readonly content: string;
  readonly source: StrategyMemoSource;
}

// エージェントが保持するヒアリング履歴の 1 エントリ。
// 既存の HearingRequest は対話運用側の表現なので、エージェント内部の記憶は別にする。
export interface HearingRecord {
  readonly askedAt: number;
  readonly question: string;
  readonly reason: string;
  readonly answer: string | null;
  readonly answeredAt: number | null;
}

// SPEC §8.3 の AgentContext。A の context は AAgent のみ、B の context は BAgent のみが触れる。
export interface AgentContext {
  readonly side: ParticipantSide;
  privateBrief: string;
  strategyMemo: StrategyMemo[];
  hearingHistory: HearingRecord[];
  readonly personality: AgentPersonality;
  turnCount: number;
}

export function createAgentContext(params: {
  side: ParticipantSide;
  personality: AgentPersonality;
  privateBrief?: string;
}): AgentContext {
  return {
    side: params.side,
    privateBrief: params.privateBrief ?? "",
    strategyMemo: [],
    hearingHistory: [],
    personality: params.personality,
    turnCount: 0,
  };
}
