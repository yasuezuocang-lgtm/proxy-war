import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
} from "discord.js";
import type { Config } from "../config.js";

export function createClient(config: Config): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Bot起動: ${c.user.tag}`);
    console.log(`サーバー: ${config.discord.guildId}`);
  });

  return client;
}

export async function startBot(config: Config): Promise<Client> {
  const client = createClient(config);

  // メッセージハンドラ（後のフェーズで本格実装）
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const channel = message.channel;
    if (!("name" in channel)) return;

    const channelName = channel.name;

    if (channelName === "control-a" || channelName === "control-b") {
      const side = channelName === "control-a" ? "A" : "B";
      await message.reply(
        `[${side}側] メッセージを受け取りました。（本格実装は次のフェーズで行います）`
      );
    }
  });

  await client.login(config.discord.token);
  return client;
}
