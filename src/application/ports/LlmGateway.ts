import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { CourtLevel } from "../../domain/value-objects/CourtLevel.js";

export interface BriefInput {
  side: ParticipantSide;
  rawInputs: string[];
}

export interface AppendBriefInput {
  side: ParticipantSide;
  currentStructuredContext: string;
  additionalInput: string;
}

export interface ProbeInput {
  side: ParticipantSide;
  structuredContext: string;
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
  side: ParticipantSide;
  loserContext: string;
  judgmentHistory: string[];
}

// 代理喧嘩の不変条件を型で切り分ける:
//
// ParticipantLlmGateway は「片側だけ扱う」LLM操作を扱う。
// 引数は常に side 付きで、片側分のブリーフ・追加発言・構造化コンテキスト。
// A/B プロンプト分離に対応するため、各メソッドは入力の side に応じて
// 内部で A 用 / B 用プロンプトを使い分ける。
export interface ParticipantLlmGateway {
  extractBrief(input: BriefInput): Promise<StructuredBrief>;
  appendBrief(input: AppendBriefInput): Promise<StructuredBrief>;
  generateProbe(input: ProbeInput): Promise<string>;
  generateConsolation(input: ConsolationInput): Promise<string>;
}

// RefereeLlmGateway は「両側を見る唯一の存在＝審判」が使う。
// 判定は両者の本音を比較する仕事なので、両側アクセスを許す唯一の契約。
//
// migration-plan §3 Step 6 / §6 二重実装解消:
// 判定の実装は infrastructure/agents/JudgeAgent.judgeRound に一本化済み。
// この interface は既存テストの Fake 用に残しているが、本番経路では使われない。
// @deprecated 新規コードは JudgeAgent / JudgePort を直接使うこと。
export interface RefereeLlmGateway {
  judgeRound(input: JudgeRoundInput): Promise<Judgment>;
}

// migration-plan §3 Step 6: 旧合成型は `ParticipantLlmGateway` のエイリアスに縮退。
// 既存の Fake 実装（`implements LlmGateway`）が judgeRound を超過実装していても
// アプリ層からは ParticipantLlmGateway としてしか参照されない。
// @deprecated 新規コードは ParticipantLlmGateway を使うこと。
export type LlmGateway = ParticipantLlmGateway;
