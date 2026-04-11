import type { LLMClient } from "../llm/provider.js";
import type { Session, SideInput } from "./session.js";
import { STRUCTURIZE_PROMPT, SUMMARY_PROMPT } from "../llm/prompts.js";

export interface InputResult {
  reply: string;
  phaseComplete: boolean;
}

export class InputProcessor {
  constructor(private llm: LLMClient) {}

  /** 第1段階: 自由入力を受け取って蓄積 */
  async addRawInput(
    side: SideInput,
    message: string
  ): Promise<InputResult> {
    side.rawMessages.push(message);

    // 短いメッセージが連続する場合は蓄積を促す
    const totalLength = side.rawMessages.join("").length;
    if (totalLength < 30 && side.rawMessages.length < 3) {
      return {
        reply: "なるほど。もっと教えてください。思っていること、全部吐き出して大丈夫です。",
        phaseComplete: false,
      };
    }

    // 構造化
    const allInput = side.rawMessages.join("\n");
    const structured = await this.llm.chat([
      { role: "system", content: STRUCTURIZE_PROMPT },
      { role: "user", content: allInput },
    ]);
    side.structured = structured.content;

    // 要約と深掘り質問を生成
    const summaryResponse = await this.llm.chat([
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: structured.content },
    ]);
    side.summary = summaryResponse.content;

    return {
      reply: summaryResponse.content,
      phaseComplete: false, // 確認を待つ
    };
  }

  /** 第2段階: 要約の確認・深掘りへの回答を処理 */
  async handleConfirmation(
    side: SideInput,
    message: string
  ): Promise<InputResult> {
    const lower = message.trim().toLowerCase();
    const isConfirm =
      lower === "はい" ||
      lower === "ok" ||
      lower === "おk" ||
      lower === "いいよ" ||
      lower === "うん" ||
      lower === "合ってる" ||
      lower === "yes" ||
      lower === "y";

    if (isConfirm) {
      side.confirmed = true;
      side.systemPrompt = this.buildSystemPrompt(side);
      return {
        reply:
          "了解しました！あなたの気持ち、しっかり受け取りました。\n相手側の準備が整い次第、代理対話を始めます。",
        phaseComplete: true,
      };
    }

    // 追加情報として扱う
    if (side.followUpCount < 3) {
      side.followUpCount++;
      side.rawMessages.push(message);

      // 再構造化
      const allInput = side.rawMessages.join("\n");
      const structured = await this.llm.chat([
        { role: "system", content: STRUCTURIZE_PROMPT },
        { role: "user", content: allInput },
      ]);
      side.structured = structured.content;

      const summaryResponse = await this.llm.chat([
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: structured.content },
      ]);
      side.summary = summaryResponse.content;

      return {
        reply: summaryResponse.content,
        phaseComplete: false,
      };
    }

    // 3回深掘りしたら自動確定
    side.confirmed = true;
    side.systemPrompt = this.buildSystemPrompt(side);
    return {
      reply:
        "十分な情報が集まりました。この内容で代理対話を進めますね。\n相手側の準備が整い次第、開始します。",
      phaseComplete: true,
    };
  }

  /** 喧嘩モード: ゴール設定 */
  setGoal(side: SideInput, goal: string): string {
    side.goal = goal;
    return `ゴールを設定しました:「${goal}」\nこのゴールの達成を目指して代理Botが議論します。`;
  }

  private buildSystemPrompt(side: SideInput): string {
    let prompt = `## ユーザーの本音（構造化済み）\n${side.structured}`;
    if (side.goal) {
      prompt += `\n\n## 議論のゴール\n${side.goal}`;
    }
    return prompt;
  }
}
