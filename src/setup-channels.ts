import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type CategoryChannel,
} from "discord.js";
import { loadConfig } from "./config.js";

const CATEGORY_NAME = "proxy-war";

const CHANNELS = [
  {
    name: "control-a",
    topic: "プレイヤーAの専用チャンネル — ここで本音をBotに伝えてください",
    private: true,
  },
  {
    name: "control-b",
    topic: "プレイヤーBの専用チャンネル — ここで本音をBotに伝えてください",
    private: true,
  },
  {
    name: "talk",
    topic: "代理Bot同士が議論を展開する共有チャンネル",
    private: false,
  },
] as const;

async function findOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_NAME
  );
  if (existing) {
    console.log(`  カテゴリ "${CATEGORY_NAME}" は既に存在します。`);
    return existing as CategoryChannel;
  }

  const category = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
  });
  console.log(`  カテゴリ "${CATEGORY_NAME}" を作成しました。`);
  return category;
}

async function findOrCreateChannel(
  guild: Guild,
  category: CategoryChannel,
  ch: (typeof CHANNELS)[number]
) {
  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === ch.name &&
      c.parentId === category.id
  );

  if (existing) {
    console.log(`  #${ch.name} は既に存在します。`);
    return existing;
  }

  const permissionOverwrites = ch.private
    ? [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ]
    : [];

  const channel = await guild.channels.create({
    name: ch.name,
    type: ChannelType.GuildText,
    parent: category,
    topic: ch.topic,
    permissionOverwrites,
  });

  const visibility = ch.private ? "(非公開)" : "(公開)";
  console.log(`  #${ch.name} を作成しました ${visibility}`);
  return channel;
}

async function main() {
  const config = loadConfig();

  console.log();
  console.log("── Discordチャンネル セットアップ ──");
  console.log();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await client.login(config.discord.token);
  console.log(`  Botログイン: ${client.user!.tag}`);

  const guild = await client.guilds.fetch({ guild: config.discord.guildId, withCounts: false });
  console.log(`  サーバー: ${guild.name} (${guild.id})`);
  console.log();

  // チャンネルキャッシュを取得
  await guild.channels.fetch();

  const category = await findOrCreateCategory(guild);

  for (const ch of CHANNELS) {
    await findOrCreateChannel(guild, category, ch);
  }

  console.log();
  console.log("  チャンネルセットアップ完了!");
  console.log();
  console.log("  次のステップ:");
  console.log(
    "    1. control-a / control-b に参加者を招待してください"
  );
  console.log(
    '       → チャンネル設定 > 権限 > メンバーを追加'
  );
  console.log("    2. npm run dev でBotを起動");
  console.log();

  await client.destroy();
}

main().catch((err) => {
  console.error("チャンネルセットアップエラー:", err);
  process.exit(1);
});
