import { ChannelType, type Client, type TextChannel } from "discord.js";
import type { LLMClient } from "../llm/provider.js";
import type { Session, DialogueTurn, HearingRequest } from "./session.js";
import { proxyBotPrompt, APPEND_PROMPT } from "../llm/prompts.js";

const TURN_DELAY_MS = 3000;
const HEARING_TIMEOUT_MS = 5 * 60 * 1000; // 5分タイムアウト
const HEARING_PATTERN = /\[HEARING:(.+?)\]/s;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HearingCallback {
  sendDM: (side: "A" | "B", message: string) => Promise<void>;
  waitForResponse: (side: "A" | "B", timeoutMs: number) => Promise<string | null>;
  updateWeapons: (side: "A" | "B", answer: string) => Promise<void>;
}

export class DebateEngine {
  constructor(private llm: LLMClient) {}

  /** 代理対話を実行する */
  async run(
    session: Session,
    talkGuildId: string,
    clientA: Client,
    clientB: Client,
    onComplete: () => Promise<void>,
    hearingCb?: HearingCallback
  ): Promise<void> {
    session.globalPhase = "talking";

    const channelA = await this.findTalkChannel(clientA, talkGuildId);
    const channelB = await this.findTalkChannel(clientB, talkGuildId);

    if (!channelA || !channelB) {
      console.error("#talk チャンネルが見つかりません（両Botがサーバーに参加しているか確認）");
      return;
    }

    const modeLabel = session.mode === "fight" ? "⚔️ 喧嘩モード" : "💬 話し合いモード";
    await channelA.send(`━━━\n${modeLabel} 開始\n━━━`);

    if (session.mode === "fight") {
      const goalA = session.sideA.goal || "なし";
      const goalB = session.sideB.goal || "なし";
      await channelA.send(`🎯 A: ${goalA}\n🎯 B: ${goalB}`);
    }

    let currentSide: "A" | "B" = "A";
    let hearingCount = { A: 0, B: 0 };

    for (let turn = 0; turn < session.maxTurns; turn++) {
      await sleep(TURN_DELAY_MS);

      const response = await this.generateTurn(session, currentSide);

      // ヒアリングリクエスト検出
      const hearingMatch = response.match(HEARING_PATTERN);
      if (hearingMatch && hearingCb && hearingCount[currentSide] < 2) {
        hearingCount[currentSide]++;
        const question = hearingMatch[1].trim();

        // #talkに通知
        const channel = currentSide === "A" ? channelA : channelB;
        await channel.send(`⏸️ ヒアリングタイム — ${currentSide}側の依頼人に確認中...`);

        session.globalPhase = "hearing";
        session.hearing = {
          side: currentSide,
          question,
          context: session.dialogue.length > 0
            ? session.dialogue[session.dialogue.length - 1].content
            : "",
          resolved: false,
          answer: null,
        };

        // DMで質問を送信
        await hearingCb.sendDM(
          currentSide,
          `⏸️ 対話中に確認したいことが出た。\n\n${question}\n\n返信して。終わったら対話再開する。`
        );

        // 回答を待つ
        const answer = await hearingCb.waitForResponse(currentSide, HEARING_TIMEOUT_MS);

        if (answer) {
          session.hearing.answer = answer;
          session.hearing.resolved = true;

          // 武器リストに追記
          await hearingCb.updateWeapons(currentSide, answer);

          await channel.send(`▶️ ヒアリング完了 — 対話再開`);
        } else {
          await channel.send(`▶️ タイムアウト — 対話再開`);
        }

        session.globalPhase = "talking";
        session.hearing = null;

        // ヒアリング結果を踏まえて再生成
        const retryResponse = await this.generateTurn(session, currentSide);
        const dialogueTurn: DialogueTurn = {
          side: currentSide,
          content: retryResponse,
          timestamp: Date.now(),
        };
        session.dialogue.push(dialogueTurn);

        const retryChannel = currentSide === "A" ? channelA : channelB;
        await retryChannel.send(retryResponse);
      } else {
        // ヒアリング不要 → 通常の発言
        const cleanResponse = response.replace(HEARING_PATTERN, "").trim();
        const dialogueTurn: DialogueTurn = {
          side: currentSide,
          content: cleanResponse || response,
          timestamp: Date.now(),
        };
        session.dialogue.push(dialogueTurn);

        const channel = currentSide === "A" ? channelA : channelB;
        await channel.send(cleanResponse || response);
      }

      currentSide = currentSide === "A" ? "B" : "A";
    }

    await channelA.send(`━━━\n対話終了（${session.dialogue.length}ターン）\n━━━`);

    await onComplete();
  }

  private async findTalkChannel(
    client: Client,
    guildId: string
  ): Promise<TextChannel | null> {
    try {
      const guild = await client.guilds.fetch({ guild: guildId, withCounts: false });
      await guild.channels.fetch();
      const channel = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildText && ch.name === "talk"
      );
      return (channel as TextChannel) || null;
    } catch {
      return null;
    }
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

    const turnNum = session.dialogue.length;
    let turnInstruction: string;

    if (turnNum === 0) {
      turnInstruction = "お前の依頼人の状況と言い分を述べろ。武器リストの事実だけ使え。";
    } else if (turnNum === 1) {
      turnInstruction = "相手の主張を聞いた上で反論しろ。その後、お前の依頼人の言い分を述べろ。武器リストにない事実は絶対に使うな。知らないことは[HEARING:質問]で依頼人に確認できる。";
    } else if (turnNum >= session.maxTurns - 2) {
      turnInstruction = "終盤だ。これまでの議論を踏まえて、お前の依頼人が本当に求めていること（インタレスト）を伝えろ。武器リストにない事実は使うな。";
    } else {
      turnInstruction = "相手の直前の発言に具体的に反論しろ。武器リストにない事実を持ち出すな。反論材料がなければ[HEARING:質問]で依頼人に確認しろ。";
    }

    messages.push({ role: "user", content: turnInstruction });

    const response = await this.llm.chat(messages);
    return response.content;
  }
}
