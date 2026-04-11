import type { TextChannel } from "discord.js";
import type { LLMClient } from "../llm/provider.js";
import type { Session, JudgmentResult } from "./session.js";
import { judgePrompt, WISDOM_PROMPT } from "../llm/prompts.js";

export class JudgeEngine {
  constructor(private llm: LLMClient) {}

  async judge(session: Session, talkChannel: TextChannel): Promise<void> {
    session.globalPhase = "judging";

    await talkChannel.send("⚖️ **審判AIが判定中...**");

    const dialogueText = session.dialogue
      .map((t) => {
        const label = t.side === "A" ? "A側" : "B側";
        return `${label}: ${t.content}`;
      })
      .join("\n\n");

    if (session.mode === "fight") {
      await this.judgeFightMode(session, talkChannel, dialogueText);
    } else {
      await this.judgeNormalMode(session, talkChannel, dialogueText);
    }

    session.globalPhase = "finished";
  }

  private async judgeFightMode(
    session: Session,
    channel: TextChannel,
    dialogueText: string
  ): Promise<void> {
    const goalInfo =
      `A側のゴール: ${session.sideA.goal || "未設定"}\nB側のゴール: ${session.sideB.goal || "未設定"}`;

    const response = await this.llm.chat([
      { role: "system", content: judgePrompt("fight") },
      {
        role: "user",
        content: `## 議論のゴール\n${goalInfo}\n\n## 議論の全文\n${dialogueText}`,
      },
    ]);

    let result: JudgmentResult;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch?.[0] || "{}") as JudgmentResult;
    } catch {
      // JSONパース失敗時はテキストそのまま返す
      await channel.send(`⚖️ **審判結果:**\n${response.content}`);
      session.globalPhase = "finished";
      return;
    }

    session.judgment = result;

    // スコアボード
    let scoreBoard = "```\n📊 スコアボード\n";
    scoreBoard += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    for (const c of result.criteria || []) {
      scoreBoard += `${c.name.padEnd(12)} A: ${c.scoreA}/5  B: ${c.scoreB}/5\n`;
      scoreBoard += `  → ${c.reason}\n`;
    }
    scoreBoard += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    scoreBoard += `合計         A: ${result.totalA}/25  B: ${result.totalB}/25\n`;
    scoreBoard += "```";

    await channel.send(scoreBoard);

    // 勝者
    const winnerText =
      result.winner === "draw"
        ? "🤝 **引き分け**"
        : `🏆 **勝者: ${result.winner}側**`;

    await channel.send(`${winnerText}\n\n${result.summary || ""}`);

    // Wisdom
    if (result.wisdom) {
      await channel.send(`\n🧠 **Wisdom Engine:**\n${result.wisdom}`);
    }
  }

  private async judgeNormalMode(
    session: Session,
    channel: TextChannel,
    dialogueText: string
  ): Promise<void> {
    // 通常モードではWisdom Engineの洞察を提供
    const response = await this.llm.chat([
      { role: "system", content: judgePrompt("normal") },
      { role: "user", content: `## 対話の全文\n${dialogueText}` },
    ]);

    let parsed: { summary?: string; insights?: string; wisdom?: string };
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] || "{}");
    } catch {
      await channel.send(`💡 **対話のまとめ:**\n${response.content}`);
      session.globalPhase = "finished";
      return;
    }

    if (parsed.summary) {
      await channel.send(`📝 **対話のまとめ:**\n${parsed.summary}`);
    }
    if (parsed.insights) {
      await channel.send(`💡 **両者へのアドバイス:**\n${parsed.insights}`);
    }
    if (parsed.wisdom) {
      await channel.send(`🧠 **Wisdom Engine:**\n${parsed.wisdom}`);
    }

    session.globalPhase = "finished";
  }
}
