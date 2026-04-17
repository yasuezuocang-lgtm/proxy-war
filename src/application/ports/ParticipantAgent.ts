import type { StructuredBrief } from "./LlmGateway.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";

declare const ownBriefBrand: unique symbol;

// 代理喧嘩の核となる不変条件:
// A代理は A の本音だけ、B代理は B の本音だけを受け取る。
// OwnBrief<Side> は brief 文字列を side でタグ付けし、
// 片側の agent に反対側の brief を渡すコードはコンパイルエラーにする。
export type OwnBrief<Side extends ParticipantSide> = string & {
  readonly [ownBriefBrand]: Side;
};

export function asOwnBrief<Side extends ParticipantSide>(
  _side: Side,
  text: string
): OwnBrief<Side> {
  return text as OwnBrief<Side>;
}

// #talk 上で両側が見ている公開対話ログ。ここは双方が見てよい。
export interface PublicTurn {
  speaker: ParticipantSide;
  message: string;
}

export interface AgentTurnInput<Side extends ParticipantSide> {
  sessionId: string;
  brief: OwnBrief<Side>;
  goal: string | null;
  conversation: PublicTurn[];
  turnIndex: number;
}

export type AgentTurnResult =
  | { type: "message"; message: string }
  | { type: "hearing"; question: string };

export interface AbsorbHearingAnswerInput<Side extends ParticipantSide> {
  sessionId: string;
  currentStructuredContext: OwnBrief<Side>;
  answer: string;
}

// 前審の判定に対して、自側の brief を根拠に筋の通った異議の材料を提案するための入力。
// judgment と dialogue は公開情報（審判AI経由）なので両側が見てよい。
// ただし brief は必ず自側のもののみ（OwnBrief<Side> で強制）。
export interface SuggestAppealInput<Side extends ParticipantSide> {
  sessionId: string;
  brief: OwnBrief<Side>;
  goal: string | null;
  dialogue: PublicTurn[];
  judgment: Judgment;
  nextCourtLevel: CourtLevel;
}

export interface ParticipantAgent<
  Side extends ParticipantSide = ParticipantSide
> {
  readonly side: Side;
  generateTurn(input: AgentTurnInput<Side>): Promise<AgentTurnResult>;
  resetSession(sessionId: string): void;
  absorbHearingAnswer(
    input: AbsorbHearingAnswerInput<Side>
  ): Promise<StructuredBrief>;
  // 自側の brief だけを根拠に、判定を覆しうる異議の材料を箇条書きで返す。
  // 返り値が空文字列なら「提案なし」。失敗時も空文字列で返す（呼び出し側で扱う）。
  suggestAppealPoints(input: SuggestAppealInput<Side>): Promise<string>;
}

export interface ParticipantAgents {
  A: ParticipantAgent<"A">;
  B: ParticipantAgent<"B">;
}
