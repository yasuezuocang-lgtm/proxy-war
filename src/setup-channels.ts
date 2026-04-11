import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type Guild,
  type CategoryChannel,
} from "discord.js";
import { loadConfig } from "./config.js";

const CATEGORY_NAME = "proxy-war";

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

async function findOrCreateTalk(
  guild: Guild,
  category: CategoryChannel
) {
  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === "talk" &&
      c.parentId === category.id
  );

  if (existing) {
    console.log("  #talk は既に存在します。");
    return existing;
  }

  const channel = await guild.channels.create({
    name: "talk",
    type: ChannelType.GuildText,
    parent: category,
    topic: "代理Bot同士が議論を展開する共有チャンネル",
  });

  console.log("  #talk を作成しました。");
  return channel;
}

async function main() {
  const config = loadConfig();

  console.log();
  console.log("── 共有サーバー チャンネルセットアップ ──");
  console.log();

  // Bot Aでログインしてチャンネルを作成
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await client.login(config.botA.token);
  console.log(`  Bot A ログイン: ${client.user!.tag}`);

  const guild = await client.guilds.fetch({
    guild: config.talkGuildId,
    withCounts: false,
  });
  console.log(`  共有サーバー: ${guild.name} (${guild.id})`);
  console.log();

  await guild.channels.fetch();

  const category = await findOrCreateCategory(guild);
  await findOrCreateTalk(guild, category);

  console.log();
  console.log("  チャンネルセットアップ完了!");
  console.log();
  console.log("  次のステップ:");
  console.log("    1. Bot B もこのサーバーに招待済みか確認");
  console.log("    2. npm run dev で両Bot起動");
  console.log();
  console.log("  使い方:");
  console.log("    ユーザーA → Bot A にDMで本音を送信");
  console.log("    ユーザーB → Bot B にDMで本音を送信");
  console.log("    → #talk で代理対話が自動開始");
  console.log();

  await client.destroy();
}

main().catch((err) => {
  console.error("チャンネルセットアップエラー:", err);
  process.exit(1);
});
