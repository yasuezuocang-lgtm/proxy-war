import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  type TextChannel,
  type DMChannel,
} from "discord.js";
import type { Config } from "../config.js";
import type { LLMClient } from "../llm/provider.js";
import { SessionManager } from "../core/session.js";
import type { Session, SideInput } from "../core/session.js";
import { InputProcessor } from "../core/input-processor.js";
import { DebateEngine, type HearingCallback } from "../core/debate.js";
import { JudgeEngine } from "../core/judge.js";
import { EncryptedStorage } from "../utils/storage.js";
import { TOPIC_EXTRACT_PROMPT, APPEND_PROMPT } from "../llm/prompts.js";

function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
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

  const deps: Deps = { sessions, input, debate, judge, storage, config, llm, clientA, clientB };

  clientA.once(Events.ClientReady, (c) => {
    console.log(`Bot A 起動: ${c.user.tag}`);
  });
  setupDMHandler(clientA, "A", deps);

  clientB.once(Events.ClientReady, (c) => {
    console.log(`Bot B 起動: ${c.user.tag}`);
  });
  setupDMHandler(clientB, "B", deps);

  await Promise.all([
    clientA.login(config.botA.token),
    clientB.login(config.botB.token),
  ]);

  return { clientA, clientB };
}

// ── ヒアリング応答待ち ──

type HearingResolver = (answer: string) => void;
const hearingResolvers = new Map<string, HearingResolver>();
// DMチャンネルキャッシュ（ヒアリング時にDM送信するため）
const dmChannelCache = new Map<string, DMChannel>();

// ── メッセージバッファ（連投を束ねる） ──

const MESSAGE_BUFFER_MS = 2000; // 2秒待って連投を束ねる

interface BufferedMessage {
  texts: string[];
  channel: DMChannel;
  timer: ReturnType<typeof setTimeout>;
}

const messageBuffers = new Map<string, BufferedMessage>();
const processingLocks = new Map<string, Promise<void>>();

// ── DM受信（raw経由 — discord.js v14のDM制限回避） ──

const processedMessages = new Set<string>();

function setupDMHandler(client: Client, side: "A" | "B", deps: Deps) {
  client.on("raw" as any, async (event: any) => {
    if (event.t !== "MESSAGE_CREATE") return;

    const data = event.d;
    if (data.guild_id) return;
    if (data.author?.bot) return;

    // メッセージID重複排除
    const msgId = data.id;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    if (processedMessages.size > 200) {
      const ids = [...processedMessages];
      ids.slice(0, 100).forEach((id) => processedMessages.delete(id));
    }

    const content = data.content || "";
    console.log(`[Bot ${side}] DM受信: ${content.slice(0, 30)}...`);

    let dmChannel: DMChannel;
    try {
      const channel = await client.channels.fetch(data.channel_id);
      if (!channel || channel.type !== ChannelType.DM) return;
      dmChannel = channel as DMChannel;
    } catch {
      return;
    }

    // ヒアリング応答は即時処理（バッファしない）
    const session = deps.sessions.get(deps.config.talkGuildId);
    if (session?.globalPhase === "hearing" && session.hearing?.side === side) {
      try {
        await handleDM(content, dmChannel, side, deps);
      } catch (err) {
        console.error(`Bot ${side} エラー:`, err);
      }
      return;
    }

    // 通常メッセージはバッファリング（連投を束ねる）
    const bufferKey = side;
    const existing = messageBuffers.get(bufferKey);

    if (existing) {
      existing.texts.push(content);
      existing.channel = dmChannel;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushBuffer(bufferKey, side, deps), MESSAGE_BUFFER_MS);
      console.log(`[Bot ${side}] バッファに追加（計${existing.texts.length}通）`);
    } else {
      const timer = setTimeout(() => flushBuffer(bufferKey, side, deps), MESSAGE_BUFFER_MS);
      messageBuffers.set(bufferKey, { texts: [content], channel: dmChannel, timer });
      console.log(`[Bot ${side}] バッファ開始`);
    }
  });
}

async function flushBuffer(bufferKey: string, side: "A" | "B", deps: Deps) {
  const buf = messageBuffers.get(bufferKey);
  if (!buf) return;
  messageBuffers.delete(bufferKey);

  const combinedText = buf.texts.join("\n");
  const channel = buf.channel;

  console.log(`[Bot ${side}] バッファ確定（${buf.texts.length}通を結合）`);

  // ロック: 同じ側の処理が並行しないようにする
  const lockKey = side;
  const prevLock = processingLocks.get(lockKey) || Promise.resolve();

  const currentLock = prevLock.then(async () => {
    try {
      await handleDM(combinedText, channel, side, deps);
    } catch (err) {
      console.error(`Bot ${side} エラー:`, err);
    }
  });

  processingLocks.set(lockKey, currentLock);
}

// ── 依存 ──

interface Deps {
  sessions: SessionManager;
  input: InputProcessor;
  debate: DebateEngine;
  judge: JudgeEngine;
  storage: EncryptedStorage;
  config: Config;
  llm: LLMClient;
  clientA: Client;
  clientB: Client;
}

// ── DM処理メイン ──

async function handleDM(
  text: string,
  channel: DMChannel,
  side: "A" | "B",
  deps: Deps
) {
  text = text.trim();
  if (!text) return;

  const { sessions, input, config } = deps;
  const sessionKey = config.talkGuildId;

  const reply = async (msg: string) => {
    await channel.send(msg);
  };

  // リセット
  const lower = text.toLowerCase();
  if (lower.includes("リセット") || lower.includes("新しく始める") || lower === "reset") {
    sessions.delete(sessionKey);
    await reply("リセットした。また本音送って。");
    return;
  }

  // セッションなし or 終了済み → 新規作成
  let session = sessions.get(sessionKey);
  if (!session || session.globalPhase === "finished") {
    session = sessions.create(sessionKey);
    const sideInput = sessions.getSide(session, side);
    sideInput.phase = "inputting";

    const result = await input.addRawInput(sideInput, text);
    if (sideInput.summary) {
      // 十分な情報 → ブリーフィング表示 → 確認フェーズへ
      sideInput.phase = "confirming";
      await reply(result.reply);
      await extractAndNotify(session, side, deps);
    } else {
      // 質問中 or 情報不足 → そのまま返す
      await reply(result.reply);
    }
    return;
  }

  const sideInput = sessions.getSide(session, side);

  // DMチャンネルをキャッシュ
  dmChannelCache.set(side, channel);

  // グローバルフェーズチェック
  if (session.globalPhase === "hearing") {
    // ヒアリング中 — この側が質問されてるなら回答として処理
    if (session.hearing && session.hearing.side === side && !session.hearing.resolved) {
      const resolver = hearingResolvers.get(side);
      if (resolver) {
        resolver(text);
        hearingResolvers.delete(side);
        await reply("👍 受け取った。対話に反映して再開する。");
      }
      return;
    }
    // 質問されてない側
    await reply("今ヒアリングタイム中。ちょっと待って。");
    return;
  }
  if (session.globalPhase === "talking") {
    await reply("今Bot同士が戦ってる。#talk 見てて。");
    return;
  }
  if (session.globalPhase === "judging") {
    await reply("判定中。ちょっと待って。");
    return;
  }

  // 各側のフェーズ
  switch (sideInput.phase) {
    case "waiting": {
      sideInput.phase = "inputting";
      const result = await input.addRawInput(sideInput, text);
      if (sideInput.summary) {
        sideInput.phase = "confirming";
        await reply(result.reply);
        await extractAndNotify(session, side, deps);
      } else {
        await reply(result.reply);
      }
      break;
    }

    case "inputting": {
      const result = await input.addRawInput(sideInput, text);
      if (sideInput.summary) {
        sideInput.phase = "confirming";
        await reply(result.reply);
        await extractAndNotify(session, side, deps);
      } else {
        await reply(result.reply);
      }
      break;
    }

    case "confirming": {
      const result = await input.handleConfirmation(sideInput, text);
      if (result.phaseComplete) {
        if (session.mode === "fight") {
          // 相手が既にfight選択済み → ゴール設定に進む
          sideInput.phase = "choosing";
          await reply(
            "相手が⚔️喧嘩モード選んでる。\n" +
            "ゴールあれば「ゴール:○○」、なければ「なし」で。"
          );
        } else if (session.mode === "normal") {
          sideInput.phase = "confirmed";
          await reply("💬話し合いモードで準備OK。");
          await checkBothReady(session, side, deps, reply);
        } else {
          sideInput.phase = "choosing";
          await reply("どっちで行く？\n⚔️「喧嘩」 or 💬「話し合い」");
        }
      } else {
        await reply(result.reply);
        if (sideInput.summary && !session.notifiedOtherSide) {
          await extractAndNotify(session, side, deps);
        }
      }
      break;
    }

    case "choosing": {
      await handleModeChoice(text, session, sideInput, side, deps, reply);
      break;
    }

    case "confirmed": {
      await reply("準備OK。相手待ち。");
      break;
    }
  }
}

// ── テーマ抽出 → 相手側に通知 ──

async function extractAndNotify(
  session: Session,
  side: "A" | "B",
  deps: Deps
) {
  if (session.notifiedOtherSide) return;

  const sideInput = deps.sessions.getSide(session, side);
  const rawText = sideInput.rawMessages.join("\n");

  try {
    const topicResponse = await deps.llm.chat([
      { role: "system", content: TOPIC_EXTRACT_PROMPT },
      { role: "user", content: rawText },
    ]);
    session.topic = topicResponse.content.trim();
  } catch {
    session.topic = "（テーマ取得中）";
  }

  session.notifiedOtherSide = true;

  const otherBotName = side === "A" ? deps.config.botB.name : deps.config.botA.name;
  const talkChannel = await findTalkChannel(deps);
  if (talkChannel) {
    await talkChannel.send(
      `📢「${session.topic}」で対話準備中。\n` +
      `もう一方の人は **${otherBotName}** にDMで本音送って。`
    );
  }
}

// ── モード選択 ──

async function handleModeChoice(
  text: string,
  session: Session,
  sideInput: SideInput,
  side: "A" | "B",
  deps: Deps,
  reply: (msg: string) => Promise<void>
) {
  const lower = text.trim().toLowerCase();

  // ゴール設定（喧嘩+ゴール同時）
  if (lower.startsWith("ゴール:") || lower.startsWith("ゴール：") || lower.startsWith("goal:")) {
    session.mode = "fight";
    session.maxTurns = 10;
    sideInput.goal = text.replace(/^(ゴール|goal)[:：]\s*/i, "");
    sideInput.phase = "confirmed";
    await reply(`⚔️ ゴール「${sideInput.goal}」で準備OK。`);
    await checkBothReady(session, side, deps, reply);
    return;
  }

  // 喧嘩モード
  if (lower.includes("喧嘩") || lower.includes("けんか") || lower.includes("論破")
      || lower === "fight" || lower === "⚔️" || lower === "⚔") {
    session.mode = "fight";
    session.maxTurns = 10;
    await reply("⚔️喧嘩モード。ゴールあれば「ゴール:○○」、なければ「なし」で。");
    return;
  }

  // 通常モード
  if (lower.includes("話し合") || lower.includes("通常") || lower.includes("相談")
      || lower.includes("穏やか") || lower === "talk" || lower === "💬") {
    if (session.mode !== "fight") session.mode = "normal";
    sideInput.phase = "confirmed";
    const modeLabel = session.mode === "fight" ? "⚔️喧嘩" : "💬話し合い";
    await reply(`${modeLabel}モードで準備OK。`);
    await checkBothReady(session, side, deps, reply);
    return;
  }

  // なし（ゴールスキップ）
  if (lower === "なし" || lower === "no" || lower === "スキップ" || lower === "skip") {
    if (session.mode === "fight") {
      sideInput.phase = "confirmed";
      await reply("⚔️ゴールなし、喧嘩モードで準備OK。");
      await checkBothReady(session, side, deps, reply);
    } else {
      await reply("先にモード選んで。⚔️「喧嘩」or 💬「話し合い」");
    }
    return;
  }

  await reply("⚔️「喧嘩」or 💬「話し合い」 どっち？");
}

// ── 両側チェック → 対話開始 ──

async function checkBothReady(
  session: Session,
  side: "A" | "B",
  deps: Deps,
  reply: (msg: string) => Promise<void>
) {
  if (deps.sessions.bothConfirmed(session)) {
    deps.storage.save(session.id, {
      sideA: session.sideA,
      sideB: session.sideB,
    });
    await reply("#talk で始める。");
    await startDebate(session, deps);
  } else {
    await reply("相手待ち。");
  }
}

// ── #talk ──

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

// ── 代理対話 ──

async function startDebate(session: Session, deps: Deps) {
  const talkChannel = await findTalkChannel(deps);
  if (!talkChannel) {
    console.error("#talk チャンネルが見つかりません");
    return;
  }

  // ヒアリングコールバック
  const hearingCb: HearingCallback = {
    sendDM: async (side: "A" | "B", message: string) => {
      const cached = dmChannelCache.get(side);
      if (cached) {
        await cached.send(message);
      } else {
        console.error(`[Hearing] ${side}側のDMチャンネルが見つかりません`);
      }
    },

    waitForResponse: (side: "A" | "B", timeoutMs: number): Promise<string | null> => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          hearingResolvers.delete(side);
          resolve(null);
        }, timeoutMs);

        hearingResolvers.set(side, (answer: string) => {
          clearTimeout(timer);
          resolve(answer);
        });
      });
    },

    updateWeapons: async (side: "A" | "B", answer: string) => {
      const sideInput = deps.sessions.getSide(session, side);
      if (!sideInput.structured) return;

      // APPEND_PROMPTで武器リストに追記
      const updated = await deps.llm.chat([
        { role: "system", content: APPEND_PROMPT },
        {
          role: "user",
          content: `【現在の分析】\n${sideInput.structured}\n\n【依頼人の追加発言】\n${answer}`,
        },
      ]);
      sideInput.structured = updated.content;
      // systemPromptも更新
      sideInput.systemPrompt = `## 依頼人の情報（スロット分析）\n${sideInput.structured}`;
      if (sideInput.goal) {
        sideInput.systemPrompt += `\n\n## 勝ち取るゴール\n${sideInput.goal}`;
      }
    },
  };

  await deps.debate.run(
    session,
    deps.config.talkGuildId,
    deps.clientA,
    deps.clientB,
    async () => {
      await deps.judge.judge(session, talkChannel);
      deps.storage.save(session.id, session);

      await talkChannel.send("━━━\n終了。もう1回やるならBotに「リセット」ってDMして。\n━━━");
    },
    hearingCb
  );
}
