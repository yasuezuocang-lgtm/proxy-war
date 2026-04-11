import {
  type Message,
  type TextChannel,
  ChannelType,
} from "discord.js";
import type { Config } from "../config.js";
import type { LLMClient } from "../llm/provider.js";
import { SessionManager, type Session } from "../core/session.js";
import { InputProcessor } from "../core/input-processor.js";
import { DebateEngine } from "../core/debate.js";
import { JudgeEngine } from "../core/judge.js";
import { EncryptedStorage } from "../utils/storage.js";

export class MessageHandler {
  private sessions: SessionManager;
  private input: InputProcessor;
  private debate: DebateEngine;
  private judge: JudgeEngine;
  private storage: EncryptedStorage;

  constructor(
    private config: Config,
    private llm: LLMClient
  ) {
    this.sessions = new SessionManager();
    this.input = new InputProcessor(llm);
    this.debate = new DebateEngine(llm);
    this.judge = new JudgeEngine(llm);
    this.storage = new EncryptedStorage(config.encryptionKey);
  }

  async handle(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.guild) return;

    const channel = message.channel;
    if (channel.type !== ChannelType.GuildText) return;

    const channelName = channel.name;

    if (channelName === "control-a") {
      await this.handleControl(message, "A");
    } else if (channelName === "control-b") {
      await this.handleControl(message, "B");
    } else if (channelName === "talk") {
      await this.handleTalkCommand(message);
    }
  }

  private async handleControl(message: Message, side: "A" | "B"): Promise<void> {
    const guildId = message.guild!.id;
    const text = message.content.trim();

    // コマンド検出
    const command = this.detectCommand(text);
    if (command) {
      await this.executeCommand(command, message, side);
      return;
    }

    const session = this.sessions.getOrCreate(guildId);

    // フェーズに応じた処理
    const inputPhase = side === "A" ? "input_a" : "input_b";
    const confirmPhase = side === "A" ? "confirm_a" : "confirm_b";
    const sideInput = this.sessions.getSide(session, side);

    if (session.phase === "idle" || session.phase === inputPhase) {
      session.phase = inputPhase;
      const result = await this.input.addRawInput(sideInput, text);
      await message.reply(result.reply);

      if (result.phaseComplete) {
        // 確認フェーズは addRawInput では起きない
      } else if (sideInput.summary) {
        session.phase = confirmPhase;
      }
    } else if (session.phase === confirmPhase) {
      const result = await this.input.handleConfirmation(sideInput, text);
      await message.reply(result.reply);

      if (result.phaseComplete) {
        // 両方揃ったらreadyに
        if (this.sessions.bothConfirmed(session)) {
          session.phase = "ready";
          this.storage.save(session.id, {
            sideA: session.sideA,
            sideB: session.sideB,
          });
          await this.notifyReady(message, session);
        }
      }
    } else if (session.phase === "talking") {
      await message.reply("現在Bot同士が対話中です。#talk チャンネルをご覧ください。");
    } else if (session.phase === "finished") {
      await message.reply(
        "前回のセッションは終了しています。\n新しいセッションを始めるには「新しく始める」と入力してください。"
      );
    } else {
      // 相手側の入力待ち等
      await message.reply(
        "メッセージを受け取りました。相手側の準備も整い次第、対話を開始します。"
      );
      // それでも入力は蓄積する
      sideInput.rawMessages.push(text);
    }
  }

  private async handleTalkCommand(message: Message): Promise<void> {
    const text = message.content.trim();
    const command = this.detectCommand(text);
    if (!command) return;

    await this.executeCommand(command, message, null);
  }

  private detectCommand(
    text: string
  ): { type: string; args: string } | null {
    const lower = text.toLowerCase();

    // 喧嘩モード開始
    if (
      lower.includes("喧嘩") ||
      lower.includes("けんか") ||
      lower.includes("論破") ||
      lower === "fight"
    ) {
      return { type: "fight", args: "" };
    }

    // 通常モード開始
    if (
      lower.includes("話し合") ||
      lower.includes("相談") ||
      lower.includes("話そう") ||
      lower === "start"
    ) {
      return { type: "start", args: "" };
    }

    // ゴール設定
    if (lower.startsWith("ゴール:") || lower.startsWith("ゴール：")) {
      return { type: "goal", args: text.replace(/^ゴール[:：]\s*/, "") };
    }

    // 判定要求
    if (lower.includes("判定") || lower === "judge") {
      return { type: "judge", args: "" };
    }

    // 対話開始
    if (lower === "go" || lower === "開始" || lower === "始めて") {
      return { type: "go", args: "" };
    }

    // リセット
    if (
      lower.includes("新しく始める") ||
      lower.includes("リセット") ||
      lower === "reset"
    ) {
      return { type: "reset", args: "" };
    }

    return null;
  }

  private async executeCommand(
    command: { type: string; args: string },
    message: Message,
    side: "A" | "B" | null
  ): Promise<void> {
    const guildId = message.guild!.id;

    switch (command.type) {
      case "fight": {
        const session = this.sessions.create(guildId, "fight");
        session.phase = "input_a";
        await message.reply(
          "⚔️ **喧嘩モード** を開始します！\n\n" +
            "まず本音を自由に書いてください。\n" +
            "その後「ゴール:〇〇」で議論のゴールを設定してください。"
        );
        break;
      }

      case "start": {
        const session = this.sessions.create(guildId, "normal");
        session.phase = "input_a";
        await message.reply(
          "💬 **通常モード** を開始します。\n\n" +
            "思っていること、感じていることを自由に書いてください。\n" +
            "Bot が整理して、相手に代わりに伝えます。"
        );
        break;
      }

      case "goal": {
        if (!side) {
          await message.reply("ゴール設定は control チャンネルで行ってください。");
          return;
        }
        const session = this.sessions.get(guildId);
        if (!session || session.mode !== "fight") {
          await message.reply("喧嘩モードでのみゴール設定ができます。");
          return;
        }
        const sideInput = this.sessions.getSide(session, side);
        const reply = this.input.setGoal(sideInput, command.args);
        await message.reply(reply);
        break;
      }

      case "go": {
        const session = this.sessions.get(guildId);
        if (!session) {
          await message.reply("セッションがありません。先に本音を入力してください。");
          return;
        }
        if (!this.sessions.bothConfirmed(session)) {
          const missingA = !session.sideA.confirmed ? "A側" : "";
          const missingB = !session.sideB.confirmed ? "B側" : "";
          const missing = [missingA, missingB].filter(Boolean).join("と");
          await message.reply(`${missing}の入力がまだ完了していません。`);
          return;
        }

        const talkChannel = await this.findTalkChannel(message);
        if (!talkChannel) {
          await message.reply("#talk チャンネルが見つかりません。");
          return;
        }

        await this.debate.run(session, talkChannel, async () => {
          if (session.mode === "fight") {
            await this.judge.judge(session, talkChannel);
          } else {
            await this.judge.judge(session, talkChannel);
          }
          this.storage.save(session.id, session);
        });
        break;
      }

      case "judge": {
        const session = this.sessions.get(guildId);
        if (!session || session.dialogue.length === 0) {
          await message.reply("まだ対話が行われていません。");
          return;
        }
        const talkChannel = await this.findTalkChannel(message);
        if (!talkChannel) {
          await message.reply("#talk チャンネルが見つかりません。");
          return;
        }
        await this.judge.judge(session, talkChannel);
        this.storage.save(session.id, session);
        break;
      }

      case "reset": {
        this.sessions.delete(guildId);
        await message.reply("セッションをリセットしました。新しく始められます。");
        break;
      }
    }
  }

  private async notifyReady(message: Message, session: Session): Promise<void> {
    const talkChannel = await this.findTalkChannel(message);
    if (talkChannel) {
      await talkChannel.send(
        "✅ **両者の準備が整いました！**\n\n" +
          "「開始」または「go」と入力すると代理対話が始まります。"
      );
    }
    await message.reply(
      "相手側も準備完了です！\n#talk チャンネルで「開始」と入力すると対話が始まります。"
    );
  }

  private async findTalkChannel(message: Message): Promise<TextChannel | null> {
    const guild = message.guild!;
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name === "talk"
    );
    return (channel as TextChannel) || null;
  }
}
