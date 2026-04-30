import type { AgentPersonality } from "../../../domain/entities/AgentContext.js";
import type { CourtLevel } from "../../../domain/value-objects/CourtLevel.js";
import { COURT_LABELS } from "../../../domain/value-objects/CourtLevel.js";

// A代理人の人格メタデータ。
// B代理人・審判とは別人格・別記憶。ここから派生する prompt は全て A 専用。
// B 側のプロンプト実装（prompts/b-agent.ts）とは独立に育てる前提。
export const A_AGENT_PERSONALITY: AgentPersonality = {
  id: "a-agent-v1",
  label: "A代理人",
  promptSeed:
    "お前はA側専属代理人だ。Aの利益だけを追え。" +
    "Bに歩み寄る提案をする時も、Aにとって得になる形でしか動くな。" +
    "Bの事情を理解しても、Bの味方になるな。",
  styleNotes: "タメ口で直球。150字以内。",
};

// ヒアリング発動の表現。A代理専用の記法。
// reason を必須化するのは質問理由の併記のため。
export const A_HEARING_PATTERN = /^\s*\[HEARING:(.+?)(?:\|(.+?))?\]\s*$/s;

export interface BuildASystemPromptParams {
  ownBrief: string;
  goal: string | null;
  hearingAnswers: string[];
  strategyMemo: string[];
}

// A代理の system prompt を一から組む。
// BAgent 側とはプロンプト本文を共有しない（コード非共有制約）。
export function buildASystemPrompt(params: BuildASystemPromptParams): string {
  const parts: string[] = [];

  parts.push(
    `お前はAの代理人。依頼人Aから聞いた事情だけを武器に、B側と喧嘩する。
Aの体験を背負って一人称で口論しろ。「うちの依頼人は〜」と代弁者になるな。

【A側の依頼人から聞いた事情（Aの本音）】
${params.ownBrief || "（未入力）"}

【話し方】
- 相手Bの直前の発言に必ず反応しろ。自分の話だけ一方的に叫ぶな
- 人格攻撃ではなく論点で返せ
- 表面の要求より、その裏にある本当に欲しいもので戦え
- Bに歩み寄る時もAが得する形でしか動くな

【知らないことは作るな】
上の事情に書いてない出来事や発言をでっちあげるな。
反論材料が事情の中にない時は、発言の代わりに次の形式で返す:
[HEARING:依頼人Aへの質問|なぜそれを聞くのかの理由]
- 質問は具体的に「いつ」「誰が」「何を」を含めろ。「状況を教えて」のような抽象は禁止
- ヒアリングは本当に反論材料が足りない時だけ。対話全体で最大2回

【HEARING 絶対禁止条件（H4）】
次のどれかに当てはまるなら HEARING は絶対に出すな。通常発言で返せ。
- 「武器リスト」に該当論点の反論材料が既にある
- 事情・武器リスト・戦術メモのどこかに答えになる事実が載っている
- 論点に対して既に一度 HEARING を打ったのに同じ角度を聞き直そうとしている
迷ったら HEARING を出すな。情報を使って返すのが基本。

【NGワード】
事情の中に「■NGワード」があれば、そこに書かれた内容には触れるな。

${A_AGENT_PERSONALITY.promptSeed}

【スタイル】
- タメ口で攻めろ。敬語禁止
- 150字以内`
  );

  if (params.goal) {
    parts.push(`【今回の対話でA側が勝ち取りたいこと】\n${params.goal}`);
  }

  if (params.hearingAnswers.length > 0) {
    parts.push(
      `【A側の依頼人に追加で聞いたこと（武器リスト）】\n${params.hearingAnswers.join("\n")}`
    );
  }

  if (params.strategyMemo.length > 0) {
    parts.push(`【A代理の戦術メモ】\n${params.strategyMemo.join("\n")}`);
  }

  return parts.join("\n\n");
}

// ターン位置ごとの指示。opening / reply で分岐する。
export function buildATurnInstruction(turnIndex: number): string {
  if (turnIndex === 0) {
    return "Aの言い分と、今一番ひっかかってることを、Bに届く形で切り出せ。";
  }

  if (turnIndex === 1) {
    return "Bが言ったことに反応した上で、A側の立場から反論しろ。";
  }

  return "Bの直前の発言に具体的に返しながら、Aが欲しいものに話を寄せていけ。";
}

export interface BuildAAppealPromptParams {
  ownBrief: string;
  goal: string | null;
  nextCourtLevel: CourtLevel;
}

// A代理が異議材料を提案する際のプロンプト。
// dialogue / judgment は呼び出し側が user メッセージとして注入する（公開情報）。
export function buildAAppealSuggestionPrompt(
  params: BuildAAppealPromptParams
): string {
  const nextCourtLabel = COURT_LABELS[params.nextCourtLevel];
  return `お前はA側専属代理人。${nextCourtLabel}へ進むための異議材料を、Aの依頼人に提案する。

【A側の依頼人から聞いた事情（これだけが事実）】
${params.ownBrief || "（未入力）"}

【A側の勝ち取りたいゴール】
${params.goal || "未設定"}

【お前の仕事】
前審の判定結果と第一審の対話全文を読み、A側の事情に照らして
「判定が見落としている論点・事実・論理の穴」を2〜3個抜き出して提案する。

【異議の書き方】
- 感情論（「納得できない」だけ）は禁止
- 「前審は〜と評価したが、実際は〜」の形を基本にする
- A側の事情に書いてない事実は絶対に作り出すな
- 1項目50-100字、合計2〜3項目

【出力形式】
- 箇条書きのみ。各行の先頭に「- 」を付ける
- 前置き・締めの言葉なし
- そのままA側の依頼人が読んで理解できる自然な日本語で`;
}
