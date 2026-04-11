import type { LLMClient } from "../llm/provider.js";
import type { SideInput } from "./session.js";
import { SLOT_EXTRACT_PROMPT, PROBE_PROMPT, BATTLE_BRIEF_PROMPT, APPEND_PROMPT } from "../llm/prompts.js";

export interface InputResult {
  reply: string;
  phaseComplete: boolean;
}

export class InputProcessor {
  constructor(private llm: LLMClient) {}

  /**
   * 自由入力 → スロット自動抽出 → 不足があれば質問、十分ならブリーフィング
   */
  async addRawInput(
    side: SideInput,
    message: string
  ): Promise<InputResult> {
    side.rawMessages.push(message);

    const totalLength = side.rawMessages.join("").length;
    if (totalLength < 10) {
      return {
        reply: "もうちょい教えて。何があった？",
        phaseComplete: false,
      };
    }

    // 初回: 全体分析 / 2回目以降: 追記
    if (!side.structured) {
      const allInput = side.rawMessages.join("\n");
      const extracted = await this.llm.chat([
        { role: "system", content: SLOT_EXTRACT_PROMPT },
        { role: "user", content: allInput },
      ]);
      side.structured = extracted.content;
    } else {
      const updated = await this.llm.chat([
        { role: "system", content: APPEND_PROMPT },
        { role: "user", content: `【現在の分析】\n${side.structured}\n\n【依頼人の追加発言】\n${message}` },
      ]);
      side.structured = updated.content;
    }

    // 不足スロットがある & まだ質問できる → 質問生成
    if (this.hasSignificantGaps(side.structured) && side.followUpCount < 3) {
      const probe = await this.llm.chat([
        { role: "system", content: PROBE_PROMPT },
        { role: "user", content: `依頼人の情報:\n${side.structured}` },
      ]);
      side.followUpCount++;
      return {
        reply: probe.content,
        phaseComplete: false,
      };
    }

    // 情報十分 → 戦闘ブリーフィング
    return this.generateBrief(side);
  }

  /**
   * 確認フェーズ: はいで確定、追加情報があれば再分析
   */
  async handleConfirmation(
    side: SideInput,
    message: string
  ): Promise<InputResult> {
    const lower = message.trim().toLowerCase();
    if (lower === "はい" || lower === "yes" || lower === "ok") {
      side.confirmed = true;
      side.systemPrompt = this.buildSystemPrompt(side);
      return { reply: "了解、これで行く。", phaseComplete: true };
    }

    // 追加情報として扱う
    side.rawMessages.push(message);

    if (side.followUpCount < 5) {
      side.followUpCount++;

      // 追記モード: 既存分析に新情報を足す
      const updated = await this.llm.chat([
        { role: "system", content: APPEND_PROMPT },
        { role: "user", content: `【現在の分析】\n${side.structured}\n\n【依頼人の追加発言】\n${message}` },
      ]);
      side.structured = updated.content;

      return this.generateBrief(side);
    }

    // 上限 → 自動確定
    side.confirmed = true;
    side.systemPrompt = this.buildSystemPrompt(side);
    return { reply: "OK、この内容で行く。", phaseComplete: true };
  }

  setGoal(side: SideInput, goal: string): string {
    side.goal = goal;
    return `ゴール:「${goal}」 これ勝ち取りにいく。`;
  }

  private async generateBrief(side: SideInput): Promise<InputResult> {
    const brief = await this.llm.chat([
      { role: "system", content: BATTLE_BRIEF_PROMPT },
      { role: "user", content: side.structured! },
    ]);
    side.summary = brief.content;

    return {
      reply: `${brief.content}\n\nこれで戦う。「はい」で確定、違うとこあれば送って`,
      phaseComplete: false,
    };
  }

  private buildSystemPrompt(side: SideInput): string {
    let prompt = `## 依頼人の情報（スロット分析）\n${side.structured}`;
    if (side.goal) {
      prompt += `\n\n## 勝ち取るゴール\n${side.goal}`;
    }
    return prompt;
  }

  /**
   * 重要スロットに不明/未確認があるかチェック
   * 事実・インタレスト・武器・弱点・NGワードを確認
   */
  private hasSignificantGaps(extracted: string): boolean {
    const gapPatterns = [
      /■インタレスト[^■]*不明/s,
      /■武器[^■]*不明/s,
      /■弱点[^■]*不明/s,
      /■NGワード[^■]*未確認/s,
    ];

    let gapCount = 0;
    for (const pattern of gapPatterns) {
      if (pattern.test(extracted)) gapCount++;
    }

    return gapCount >= 2;
  }
}
