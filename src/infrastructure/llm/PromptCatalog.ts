import {
  APPEND_PROMPT,
  BATTLE_BRIEF_PROMPT,
  PROBE_PROMPT,
  REVISION_REFLECTION_PROMPT,
  SLOT_EXTRACT_PROMPT,
  judgePrompt,
  type JudgeCourtLevel,
} from "../../llm/prompts.js";

// A 用 / B 用エントリを独立に持つ。
// 中身が同一でも別エントリで提供することで、将来 A/B で異なる戦略・口調を
// 採用できる構造を確保する。判定（審判）のみ単一エントリ（中立・両側を見る）。
export class PromptCatalog {
  // ── slot 抽出（依頼人入力 → 構造化ブリーフ） ──
  slotExtractA(): string {
    return SLOT_EXTRACT_PROMPT;
  }
  slotExtractB(): string {
    return SLOT_EXTRACT_PROMPT;
  }

  // ── 追加発言の取り込み ──
  appendA(): string {
    return APPEND_PROMPT;
  }
  appendB(): string {
    return APPEND_PROMPT;
  }

  // ── 追加質問（プローブ） ──
  probeA(): string {
    return PROBE_PROMPT;
  }
  probeB(): string {
    return PROBE_PROMPT;
  }

  // ── 確認用要約（ブリーフ） ──
  briefA(): string {
    return BATTLE_BRIEF_PROMPT;
  }
  briefB(): string {
    return BATTLE_BRIEF_PROMPT;
  }

  // ── 訂正・追加発言の反映 ──
  revisionReflectionA(): string {
    return REVISION_REFLECTION_PROMPT;
  }
  revisionReflectionB(): string {
    return REVISION_REFLECTION_PROMPT;
  }

  // ── 審判（中立・両側を見る唯一の存在） ──
  judge(courtLevel: JudgeCourtLevel = "district"): string {
    return judgePrompt("fight", courtLevel);
  }

  // ── 慰め文（敗者専用） ──
  consolationA(loserContext: string, judgmentHistory: string): string {
    return this.buildConsolation(loserContext, judgmentHistory);
  }
  consolationB(loserContext: string, judgmentHistory: string): string {
    return this.buildConsolation(loserContext, judgmentHistory);
  }

  private buildConsolation(loserContext: string, judgmentHistory: string): string {
    return `お前は代理戦争の担当者。複数回戦って負けた依頼人に最後のメッセージを送る。

【負けた側の背景】
${loserContext}

【審判の記録】
${judgmentHistory}

【書き方】
- タメ口。AIっぽい丁寧語禁止
- 「お前の怒りは本物だった」ことを最初に認めろ
- 同じ結果が続いた事実は責めずに淡々と伝えろ
- 「この経験をどう活かすか」を1つだけ具体的に渡せ
- 空虚な励ましは禁止
- 150-200字`;
  }
}
