import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type DMChannel,
  type TextChannel,
} from "discord.js";
import type { Config } from "../config.js";
import type { LLMClient } from "../llm/provider.js";
import { DebateCoordinator } from "../application/coordinators/DebateCoordinator.js";
import { SessionStateMachine } from "../application/services/SessionStateMachine.js";
import { SessionRestorer } from "../application/services/SessionRestorer.js";
import { InMemorySessionRepository } from "../infrastructure/persistence/InMemorySessionRepository.js";
import type { SessionRepository } from "../application/ports/SessionRepository.js";
import { AAgent } from "../infrastructure/agents/AAgent.js";
import { BAgent } from "../infrastructure/agents/BAgent.js";
import { JudgeAgent } from "../infrastructure/agents/JudgeAgent.js";
import { createDiscordInputCoordinator } from "../presentation/discord/createDiscordInputCoordinator.js";

const MESSAGE_BUFFER_MS = 2000;
const processedMessages = new Set<string>();

interface BufferedMessage {
  texts: string[];
  channel: DMChannel;
  timer: ReturnType<typeof setTimeout>;
}

interface Deps {
  config: Config;
  inputSessionRepository: SessionRepository;
  inputCoordinator: ReturnType<typeof createDiscordInputCoordinator>["coordinator"];
  registerDmChannel: ReturnType<typeof createDiscordInputCoordinator>["registerDmChannel"];
  debateCoordinator: DebateCoordinator;
}

const messageBuffers = new Map<string, BufferedMessage>();
const processingLocks = new Map<string, Promise<void>>();
const runningDebates = new Set<string>();

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

// sessionRepository は呼び出し側（index.ts）から差し込める。
// 本番は EncryptedSessionRepository を渡してセッションを暗号化永続化する。
// 未指定時は InMemorySessionRepository を使い、プロセス寿命だけのセッションに退行する
// （テスト・開発用フォールバック）。
export async function startBots(
  config: Config,
  llm: LLMClient,
  sessionRepository?: SessionRepository
) {
  const clientA = createDiscordClient();
  const clientB = createDiscordClient();
  const inputSessionRepository: SessionRepository =
    sessionRepository ?? new InMemorySessionRepository();

  const resolveTalkChannel = (client: Client) => async () => {
    try {
      const guild = await client.guilds.fetch({
        guild: config.talkGuildId,
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
  };

  const getTalkChannelA = resolveTalkChannel(clientA);
  const getTalkChannelB = resolveTalkChannel(clientB);

  const {
    coordinator: inputCoordinator,
    pendingResponseRegistry,
    registerDmChannel,
    messageGateway,
    llmGateway,
  } = createDiscordInputCoordinator({
    guildId: config.talkGuildId,
    llmClient: llm,
    sessionRepository: inputSessionRepository,
    botNames: {
      A: config.botA.name,
      B: config.botB.name,
    },
    getTalkChannelBySide: {
      A: getTalkChannelA,
      B: getTalkChannelB,
    },
    getSystemTalkChannel: getTalkChannelA,
  });

  // AAgent / BAgent は ParticipantAgent<Side> に加えて
  // DebateCoordinator が要求する suggestAppealPoints / resetSession / getLastBrief
  // を公開メソッドとして持つ（= DebateAgent<Side> を満たす）。そのまま渡せる。
  const aAgent = new AAgent(llm, llmGateway);
  const bAgent = new BAgent(llm, llmGateway);
  const judgeAgent = new JudgeAgent(llm);
  const debateCoordinator = new DebateCoordinator(
    inputSessionRepository,
    new SessionStateMachine(),
    { A: aAgent, B: bAgent },
    llmGateway,
    judgeAgent,
    messageGateway,
    pendingResponseRegistry
  );

  const deps: Deps = {
    config,
    inputSessionRepository,
    inputCoordinator,
    registerDmChannel,
    debateCoordinator,
  };

  clientA.once(Events.ClientReady, () => {});
  clientB.once(Events.ClientReady, () => {});

  setupDMHandler(clientA, "A", deps);
  setupDMHandler(clientB, "B", deps);

  await Promise.all([
    clientA.login(config.botA.token),
    clientB.login(config.botB.token),
  ]);

  // 永続化されている active セッションを復元する。
  // mid-debate（debating/judging/hearing/appeal_pending）は安全に再開不可能なため
  // archive + #talk 告知で利用者に「やり直してね」を伝える。
  // preparing/ready はそのまま保持し、次の DM で通常フローに戻る。
  const restorer = new SessionRestorer(inputSessionRepository, messageGateway);
  try {
    await restorer.restore(config.talkGuildId);
  } catch (error) {
    console.error("セッション復元エラー:", error);
  }

  return { clientA, clientB };
}

function setupDMHandler(client: Client, side: "A" | "B", deps: Deps) {
  client.on("raw" as never, async (event: { t?: string; d?: any }) => {
    if (event.t !== "MESSAGE_CREATE") {
      return;
    }

    const data = event.d;
    if (!data || data.guild_id || data.author?.bot) {
      return;
    }

    const msgId = data.id;
    if (processedMessages.has(msgId)) {
      return;
    }
    processedMessages.add(msgId);
    if (processedMessages.size > 200) {
      const ids = [...processedMessages];
      ids.slice(0, 100).forEach((id) => processedMessages.delete(id));
    }

    const content = data.content || "";

    let dmChannel: DMChannel;
    try {
      const channel = await client.channels.fetch(data.channel_id);
      if (!channel || channel.type !== ChannelType.DM) {
        return;
      }
      dmChannel = channel as DMChannel;
    } catch {
      return;
    }

    const bufferKey = side;
    const existing = messageBuffers.get(bufferKey);

    if (existing) {
      existing.texts.push(content);
      existing.channel = dmChannel;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(
        () => flushBuffer(bufferKey, side, deps),
        MESSAGE_BUFFER_MS
      );
      return;
    }

    const timer = setTimeout(
      () => flushBuffer(bufferKey, side, deps),
      MESSAGE_BUFFER_MS
    );
    messageBuffers.set(bufferKey, { texts: [content], channel: dmChannel, timer });
  });
}

async function flushBuffer(bufferKey: string, side: "A" | "B", deps: Deps) {
  const buffered = messageBuffers.get(bufferKey);
  if (!buffered) {
    return;
  }

  messageBuffers.delete(bufferKey);
  const combinedText = buffered.texts.join("\n");
  const channel = buffered.channel;

  const previousLock = processingLocks.get(side) || Promise.resolve();
  const currentLock = previousLock.then(async () => {
    try {
      await handleDM(combinedText, channel, side, deps);
    } catch (error) {
      console.error(`Bot ${side} エラー:`, error);
    }
  });

  processingLocks.set(side, currentLock);
}

async function handleDM(
  text: string,
  channel: DMChannel,
  side: "A" | "B",
  deps: Deps
) {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return;
  }

  const guildId = deps.config.talkGuildId;
  deps.registerDmChannel(side, channel);

  // debating/judging フェーズでの「今戦ってる／判定中」案内は
  // DiscordInputCoordinator 側に移譲。リセットを全フェーズで効かせるには
  // ここで早期 return してはいけない（リセット文字列も弾かれてしまうため）。
  await deps.inputCoordinator.handleDirectMessage({
    guildId,
    side,
    text: trimmedText,
    channel,
  });

  // orchestrator は await せずに非同期起動する。
  //   handleDM は side ごとの processingLocks にぶら下がっているため、
  //   ここで await すると「orchestrator が上告待ちでブロック中」→
  //   「上告者本人の DM が同じ side の lock 解放待ちでブロック」→
  //   デッドロック。上告が永遠に検知されなくなる。
  //   orchestrator は内部で runningDebates ガードがあるので多重起動しない。
  void maybeStartDebate(guildId, deps).catch((error) => {
    console.error(`Bot ${side} 対話実行エラー:`, error);
  });
}

async function maybeStartDebate(guildId: string, deps: Deps) {
  const session = await deps.inputSessionRepository.findActiveByGuildId(guildId);
  if (!session || session.phase !== "ready") {
    return;
  }
  if (runningDebates.has(session.id)) {
    return;
  }

  runningDebates.add(session.id);
  try {
    await deps.debateCoordinator.run(session.id);
  } finally {
    runningDebates.delete(session.id);
  }
}
