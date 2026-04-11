import type { TextChannel } from "discord.js";
import type { LLMClient } from "../llm/provider.js";
import type { Session, DialogueTurn } from "./session.js";
import { proxyBotPrompt } from "../llm/prompts.js";

const TURN_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DebateEngine {
  constructor(private llm: LLMClient) {}

  /** 代理対話を実行する */
  async run(
    session: Session,
    talkChannel: TextChannel,
    onComplete: () => Promise<void>
  ): Promise<void> {
    session.phase = "talking";

    const modeLabel = session.mode === "fight" ? "⚔️ 喧嘩モード" : "💬 通常モード";
    await talkChannel.send(
      `━━━━━━━━━━━━━━━━━━━━\n${modeLabel} — 代理対話を開始します\n━━━━━━━━━━━━━━━━━━━━`
    );

    if (session.mode === "fight") {
      const goalA = session.sideA.goal || "（未設定）";
      const goalB = session.sideB.goal || "（未設定）";
      await talkChannel.send(`🎯 A側のゴール: ${goalA}\n🎯 B側のゴール: ${goalB}`);
    }

    // 最初はA側から
    let currentSide: "A" | "B" = "A";

    for (let turn = 0; turn < session.maxTurns; turn++) {
      await sleep(TURN_DELAY_MS);

      const response = await this.generateTurn(session, currentSide);
      const dialogueTurn: DialogueTurn = {
        side: currentSide,
        content: response,
        timestamp: Date.now(),
      };
      session.dialogue.push(dialogueTurn);

      const emoji = currentSide === "A" ? "🔵" : "🔴";
      await talkChannel.send(`${emoji} **${currentSide}側の代理Bot:**\n${response}`);

      currentSide = currentSide === "A" ? "B" : "A";
    }

    await talkChannel.send(
      `━━━━━━━━━━━━━━━━━━━━\n対話終了（${session.dialogue.length}ターン）\n━━━━━━━━━━━━━━━━━━━━`
    );

    await onComplete();
  }

  private async generateTurn(
    session: Session,
    side: "A" | "B"
  ): Promise<string> {
    const sideInput = side === "A" ? session.sideA : session.sideB;
    const systemPrompt = proxyBotPrompt(
      side,
      sideInput.systemPrompt || sideInput.structured || "",
      session.mode
    );

    // 対話履歴をメッセージに変換
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const turn of session.dialogue) {
      if (turn.side === side) {
        messages.push({ role: "assistant", content: turn.content });
      } else {
        messages.push({ role: "user", content: turn.content });
      }
    }

    // 最初のターンまたは相手の発言後
    if (session.dialogue.length === 0) {
      messages.push({
        role: "user",
        content: "議論を始めてください。あなたの立場から最初の発言をしてください。",
      });
    }

    const response = await this.llm.chat(messages);
    return response.content;
  }
}
