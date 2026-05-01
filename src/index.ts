import { loadConfig } from "./config.js";
import { startBots } from "./bot/client.js";
import { createLLMClient } from "./llm/provider.js";
import { EncryptedSessionRepository } from "./infrastructure/persistence/EncryptedSessionRepository.js";

async function main() {
  console.log();
  console.log("proxy-war 起動中...");
  console.log();

  const config = loadConfig();

  const llm = await createLLMClient(config);
  console.log(`LLM: ${config.llm.provider} (${config.llm.model})`);

  // セッションは data/sessions/ に AES-256-GCM で暗号化永続化。
  // 起動時に findActiveByGuildId がディスクから前回セッションを自動で読み戻すので、
  // これを startBots に渡すことで「再起動後もセッションが生きている」を実現する。
  const sessionRepository = new EncryptedSessionRepository({
    encryptionKey: config.encryptionKey,
  });

  const { clientA, clientB } = await startBots(config, llm, sessionRepository);

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
