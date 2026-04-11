import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  type TextChannel,
} from "discord.js";
import type { Config } from "../config.js";
import type { LLMClient } from "../llm/provider.js";
import { SessionManager } from "../core/session.js";
import { InputProcessor } from "../core/input-processor.js";
import { DebateEngine } from "../core/debate.js";
import { JudgeEngine } from "../core/judge.js";
import { EncryptedStorage } from "../utils/storage.js";

function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
}

export async function startBots(config: Config, llm: LLMClient) {
  const clientA = createDiscordClient();
  const clientB = createDiscordClient();

  const sessions = new SessionManager();
  const input = new InputProcessor(llm);
  const debate = new DebateEngine(llm);
  const judge = new JudgeEngine(llm);
  const storage = new EncryptedStorage(config.encryptionKey);

  // ── Bot A ──
  clientA.once(Events.ClientReady, (c) => {
    console.log(`Bot A 起動: ${c.user.tag}`);
  });

  clientA.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;

    try {
      await handleDM(message, "A", {
        sessions, input, debate, judge, storage, config, clientA, clientB,
      });
    } catch (err) {
      console.error("Bot A エラー:", err);
      await message.reply("エラーが発生しました。もう一度試してください。").catch(() => {});
    }
  });

  // ── Bot B ──
  clientB.once(Events.ClientReady, (c) => {
    console.log(`Bot B 起動: ${c.user.tag}`);
  });

  clientB.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;

    try {
      await handleDM(message, "B", {
        sessions, input, debate, judge, storage, config, clientA, clientB,
      });
    } catch (err) {
      console.error("Bot B エラー:", err);
      await message.reply("エラーが発生しました。もう一度試してください。").catch(() => {});
    }
  });

  await Promise.all([
    clientA.login(config.botA.token),
    clientB.login(config.botB.token),
  ]);

  return { clientA, clientB };
}

// ── 共通のDMハンドラ ──

interface Deps {
  sessions: SessionManager;
  input: InputProcessor;
  debate: DebateEngine;
  judge: JudgeEngine;
  storage: EncryptedStorage;
  config: Config;
  clientA: Client;
  clientB: Client;
}

async function handleDM(
  message: import("discord.js").Message,
  side: "A" | "B",
  deps: Deps
) {
  const text = message.content.trim();
  const { sessions, input, config } = deps;
  const sessionKey = config.talkGuildId;

  // コマンド検出
  const command = detectCommand(text);
  if (command) {
    await executeCommand(command, message, side, deps);
    return;
  }

  const session = sessions.getOrCreate(sessionKey);
  const sideInput = sessions.getSide(session, side);

  // グローバルフェーズのチェック
  if (session.globalPhase === "talking") {
    await message.reply("現在Bot同士が対話中です。共有サーバーの #talk をご覧ください。");
    return;
  }
  if (session.globalPhase === "judging") {
    await message.reply("審判AIが判定中です。少々お待ちください。");
    return;
  }
  if (session.globalPhase === "finished") {
    await message.reply(
      "前回のセッションは終了しています。\n新しく始めるには「話し合おう」や「喧嘩」と送ってください。"
    );
    return;
  }

  // 各側のフェーズで独立処理（A/B同時進行可能）
  switch (sideInput.phase) {
    case "waiting": {
      // まだこの側は入力を始めていない → 入力開始
      sideInput.phase = "inputting";
      const result = await input.addRawInput(sideInput, text);
      await message.reply(result.reply);
      if (sideInput.summary) {
        sideInput.phase = "confirming";
      }
      break;
    }

    case "inputting": {
      const result = await input.addRawInput(sideInput, text);
      await message.reply(result.reply);
      if (sideInput.summary) {
        sideInput.phase = "confirming";
      }
      break;
    }

    case "confirming": {
      const result = await input.handleConfirmation(sideInput, text);
      await message.reply(result.reply);

      if (result.phaseComplete) {
        sideInput.phase = "confirmed";

        // 両方確定したら対話開始
        if (sessions.bothConfirmed(session)) {
          deps.storage.save(session.id, {
            sideA: session.sideA,
            sideB: session.sideB,
          });

          await message.reply("相手側も準備完了！ #talk で代理対話を開始します...");
          await notifyOtherSide(side, deps, "相手側も準備完了！代理対話を開始します...");
          await startDebate(session, deps);
        } else {
          await message.reply("あなたの準備は完了です。相手側の入力を待っています...");
        }
      }
      break;
    }

    case "confirmed": {
      await message.reply("あなたの入力は確定済みです。相手側の準備を待っています...");
      break;
    }
  }
}

function detectCommand(text: string): { type: string; args: string } | null {
  const lower = text.toLowerCase();

  if (lower.includes("喧嘩") || lower.includes("けんか") || lower.includes("論破") || lower === "fight") {
    return { type: "fight", args: "" };
  }
  if (lower.includes("話し合") || lower.includes("相談") || lower.includes("話そう") || lower === "start") {
    return { type: "start", args: "" };
  }
  if (lower.startsWith("ゴール:") || lower.startsWith("ゴール：")) {
    return { type: "goal", args: text.replace(/^ゴール[:：]\s*/, "") };
  }
  if (lower.includes("新しく始める") || lower.includes("リセット") || lower === "reset") {
    return { type: "reset", args: "" };
  }

  return null;
}

async function executeCommand(
  command: { type: string; args: string },
  message: import("discord.js").Message,
  side: "A" | "B",
  deps: Deps
) {
  const sessionKey = deps.config.talkGuildId;

  switch (command.type) {
    case "fight": {
      const session = deps.sessions.create(sessionKey, "fight");
      // この側の入力を開始
      const sideInput = deps.sessions.getSide(session, side);
      sideInput.phase = "inputting";
      await message.reply(
        "⚔️ **喧嘩モード** を開始します！\n\n" +
          "まず本音を自由に書いてください。\n" +
          "その後「ゴール:〇〇」で議論のゴールを設定してください。\n\n" +
          "※ 相手にもBotへDMで本音を送るよう伝えてください。"
      );
      await notifyOtherSide(side, deps,
        "⚔️ 相手が **喧嘩モード** を開始しました！\n私にDMで本音を自由に書いてください。\n「ゴール:〇〇」でゴールも設定できます。"
      );
      break;
    }

    case "start": {
      const session = deps.sessions.create(sessionKey, "normal");
      const sideInput = deps.sessions.getSide(session, side);
      sideInput.phase = "inputting";
      await message.reply(
        "💬 **通常モード** を開始します。\n\n" +
          "思っていること、感じていることを自由に書いてください。\n" +
          "私が整理して、代わりに相手と話し合います。\n\n" +
          "※ 相手にもBotへDMで本音を送るよう伝えてください。"
      );
      await notifyOtherSide(side, deps,
        "💬 相手が **通常モード** を開始しました！\n私にDMで思っていることを自由に書いてください。"
      );
      break;
    }

    case "goal": {
      const session = deps.sessions.get(sessionKey);
      if (!session || session.mode !== "fight") {
        await message.reply("喧嘩モードでのみゴール設定ができます。先に「喧嘩」と送ってください。");
        return;
      }
      const sideInput = deps.sessions.getSide(session, side);
      sideInput.goal = command.args;
      await message.reply(`ゴールを設定しました:「${command.args}」\nこのゴールの達成を目指して代理Botが議論します。`);
      break;
    }

    case "reset": {
      deps.sessions.delete(sessionKey);
      await message.reply("セッションをリセットしました。新しく始められます。");
      break;
    }
  }
}

async function notifyOtherSide(
  currentSide: "A" | "B",
  deps: Deps,
  text: string
) {
  try {
    const talkChannel = await findTalkChannel(deps);
    if (talkChannel) {
      const otherLabel = currentSide === "A" ? "B" : "A";
      await talkChannel.send(`📢 **${otherLabel}側へ:** ${text}`);
    }
  } catch {
    // 通知失敗は無視
  }
}

async function findTalkChannel(deps: Deps): Promise<TextChannel | null> {
  try {
    const guild = await deps.clientA.guilds.fetch({
      guild: deps.config.talkGuildId,
      withCounts: false,
    });
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name === "talk"
    );
    return (channel as TextChannel) || null;
  } catch {
    return null;
  }
}

async function startDebate(
  session: import("../core/session.js").Session,
  deps: Deps
) {
  const talkChannel = await findTalkChannel(deps);
  if (!talkChannel) {
    console.error("#talk チャンネルが見つかりません");
    return;
  }

  await deps.debate.run(session, talkChannel, async () => {
    await deps.judge.judge(session, talkChannel);
    deps.storage.save(session.id, session);
  });
}
