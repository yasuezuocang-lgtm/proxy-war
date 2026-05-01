import type { ParticipantSide } from "./Participant.js";

// 人格プロンプト（A/B/審判 で独立した人格を表現するためのメタデータ）。
export interface AgentPersonality {
  readonly id: string;
  readonly label: string;
  readonly promptSeed: string;
  readonly styleNotes?: string;
}

// 戦術ノートの 1 エントリ。string[] でなく、出典・時刻を持つ構造化追記型にする。
// （ヒアリング回答の構造化追記で出典・時刻が必要なため。）
export type StrategyNoteSource =
  | "opening"
  | "reply"
  | "hearing_answer"
  | "external";

export interface StrategyNote {
  readonly addedAt: number;
  readonly content: string;
  readonly source: StrategyNoteSource;
}

// エージェントが保持するヒアリング履歴の 1 エントリ。
// 既存の HearingRequest は対話運用側の表現なので、エージェント内部の記憶は別にする。
export interface HearingExchange {
  readonly askedAt: number;
  readonly question: string;
  readonly reason: string;
  readonly answer: string | null;
  readonly answeredAt: number | null;
}

// AgentContext。A の context は AAgent のみ、B の context は BAgent のみが触れる。
export interface AgentContext {
  readonly side: ParticipantSide;
  privateBrief: string;
  strategyNotes: StrategyNote[];
  hearingHistory: HearingExchange[];
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
    strategyNotes: [],
    hearingHistory: [],
    personality: params.personality,
    turnCount: 0,
  };
}
