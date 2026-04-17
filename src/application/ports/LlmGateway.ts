import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";

export interface BriefInput {
  rawInputs: string[];
}

export interface AppendBriefInput {
  currentStructuredContext: string;
  additionalInput: string;
}

export interface StructuredBrief {
  structuredContext: string;
  summary: string;
}

export interface JudgeRoundInput {
  courtLevel: CourtLevel;
  contextA: string;
  contextB: string;
  goalA: string | null;
  goalB: string | null;
  dialogue: { speaker: "A" | "B"; message: string }[];
  previousJudgments: Judgment[];
  appeal: Appeal | null;
}

export interface ConsolationInput {
  loserContext: string;
  judgmentHistory: string[];
}

// 代理喧嘩の不変条件を型で切り分ける:
//
// ParticipantLlmGateway は「片側だけ扱う」LLM操作を扱う。
// 引数は常に一人分の本音・追加発言・構造化コンテキスト。
// ここに両側の文字列を一度に流し込むコードは型的に書けない。
export interface ParticipantLlmGateway {
  extractBrief(input: BriefInput): Promise<StructuredBrief>;
  appendBrief(input: AppendBriefInput): Promise<StructuredBrief>;
  generateProbe(structuredContext: string): Promise<string>;
  generateConsolation(input: ConsolationInput): Promise<string>;
}

// RefereeLlmGateway は「両側を見る唯一の存在＝審判」が使う。
// 判定は両者の本音を比較する仕事なので、両側アクセスを許す唯一の契約。
export interface RefereeLlmGateway {
  judgeRound(input: JudgeRoundInput): Promise<Judgment>;
}

// 実装クラスは両方を束ねて実装してよい（= 同じLLMプロバイダーで全用途を賄う）。
// ただしアプリケーション層は必要な側だけを型として受け取ること。
export interface LlmGateway
  extends ParticipantLlmGateway,
    RefereeLlmGateway {}
