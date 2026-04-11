import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import type { Config } from "../config.js";
import type { LLMClient } from "../llm/provider.js";
import { MessageHandler } from "./handler.js";

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

export async function startBot(config: Config, llm: LLMClient): Promise<Client> {
  const client = createClient(config);
  const handler = new MessageHandler(config, llm);

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handler.handle(message);
    } catch (err) {
      console.error("メッセージ処理エラー:", err);
      if (message.channel.isTextBased() && "send" in message.channel) {
        await message.channel.send("エラーが発生しました。もう一度試してください。").catch(() => {});
      }
    }
  });

  await client.login(config.discord.token);
  return client;
}
