import { loadConfig } from "./config.js";
import { startBots } from "./bot/client.js";
import { createLLMClient } from "./llm/provider.js";

async function main() {
  console.log();
  console.log("proxy-war 起動中...");
  console.log();

  const config = loadConfig();

  const llm = await createLLMClient(config);
  console.log(`LLM: ${config.llm.provider} (${config.llm.model})`);

  const { clientA, clientB } = await startBots(config, llm);

  const shutdown = async () => {
    console.log("\nシャットダウン中...");
    clientA.destroy();
    clientB.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("起動エラー:", err.message);
  process.exit(1);
});
