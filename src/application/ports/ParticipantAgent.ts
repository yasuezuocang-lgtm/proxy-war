import type { AgentPersonality } from "../../domain/entities/AgentContext.js";
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

// 代理人エージェントが 1 ターンの末に出す結果。
// hearing バリアントに reason を必須化しているのは質問理由の併記のため。
export type AgentTurnResult =
  | { type: "message"; message: string }
  | { type: "hearing"; question: string; reason: string };

export interface AbsorbHearingAnswerInput<Side extends ParticipantSide> {
  sessionId: string;
  currentStructuredContext: OwnBrief<Side>;
  answer: string;
}

// ヒアリング追撃用の入出力。
// 直前に投げた質問と依頼人からの回答を代理人に見せ、
// 「回答が十分か／追撃が要るか」を決めさせる。
export interface ReviewHearingAnswerInput<Side extends ParticipantSide> {
  sessionId: string;
  currentStructuredContext: OwnBrief<Side>;
  question: string;
  answer: string;
}

export type HearingAnswerReview =
  | { type: "sufficient" }
  | { type: "followup"; question: string; reason: string };

// 専属代理人エージェントの抽象。
// A代理・B代理はそれぞれ独立した人格・記憶・戦術メモを持つ。
// 同一クラスを side 切り替えで使い回さない。実装は AAgent / BAgent が独立クラス。
export interface ParticipantAgent<
  Side extends ParticipantSide = ParticipantSide
> {
  readonly side: Side;
  readonly personality: AgentPersonality;
  generateOpeningTurn(input: AgentTurnInput<Side>): Promise<AgentTurnResult>;
  generateReplyTurn(input: AgentTurnInput<Side>): Promise<AgentTurnResult>;
  absorbHearingAnswer(input: AbsorbHearingAnswerInput<Side>): Promise<void>;
  // 直近のヒアリング回答を見て「十分」か「追撃必要」かを決める。
  // 追撃の場合は [HEARING:Q|R] と同等の具体性制約を満たした新しい質問を返す。
  reviewHearingAnswer(
    input: ReviewHearingAnswerInput<Side>
  ): Promise<HearingAnswerReview>;
  getStrategyMemo(): string;
}

export interface ParticipantAgents {
  A: ParticipantAgent<"A">;
  B: ParticipantAgent<"B">;
}

// DebateCoordinator が実体として結線する代理人の契約。
// ParticipantAgent<Side>（純粋な対話ターン契約）に、
// オーケストレーション時に必要な周辺操作（異議材料提案・セッション破棄・
// ヒアリング統合後の brief 取り出し）を拡張して追加する。
//
// ここで拡張メソッドを ParticipantAgent 本体に入れなかった理由:
// - ParticipantAgent interface は「1 ターンの生成と記憶吸収」だけに絞られている
// - 異議提案や session reset はセッション境界の運用で、対話のコア責務ではない
// - getLastBrief は absorbHearingAnswer が Promise<void> になった後でも
//   司会（orchestrator）が session.brief を更新できるようにする出口。
//   agent が内部で appendBrief した結果を stash → ここで取り出す。
export interface DebateAgent<Side extends ParticipantSide = ParticipantSide>
  extends ParticipantAgent<Side> {
  suggestAppealPoints(input: SuggestAppealInput<Side>): Promise<string>;
  resetSession(sessionId: string): void;
  getLastBrief(sessionId: string): StructuredBrief | null;
}

export interface DebateAgents {
  A: DebateAgent<"A">;
  B: DebateAgent<"B">;
}

export interface SuggestAppealInput<Side extends ParticipantSide> {
  sessionId: string;
  brief: OwnBrief<Side>;
  goal: string | null;
  dialogue: PublicTurn[];
  judgment: Judgment;
  nextCourtLevel: CourtLevel;
}
