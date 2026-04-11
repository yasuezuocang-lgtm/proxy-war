import * as readline from "readline/promises";
import { randomBytes } from "crypto";
import { writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { LLM_PROVIDERS, type LLMProvider } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../.env");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function header() {
  console.log();
  console.log("╔══════════════════════════════════════════╗");
  console.log("║        proxy-war セットアップ            ║");
  console.log("║   AI代理論破・審判Botシステム            ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();
}

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function select(
  question: string,
  options: readonly string[],
  defaultIndex = 0
): Promise<string> {
  console.log(`  ${question}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? ">" : " ";
    console.log(`    ${marker} ${i + 1}. ${options[i]}`);
  }
  const answer = await ask("番号を選択", String(defaultIndex + 1));
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  return options[defaultIndex];
}

async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (y/N)`);
  return answer.toLowerCase() === "y";
}

async function setupDiscord(): Promise<{
  token: string;
  guildId: string;
}> {
  console.log("── Discord Bot 設定 ──");
  console.log();
  console.log("  Discord Developer Portal でBotを作成してください:");
  console.log("  https://discord.com/developers/applications");
  console.log();
  console.log("  必要な権限 (Bot Permissions):");
  console.log("    - Send Messages");
  console.log("    - Read Message History");
  console.log("    - Manage Channels");
  console.log("    - View Channels");
  console.log();
  console.log("  Privileged Gateway Intents:");
  console.log("    - Message Content Intent を有効にしてください");
  console.log();

  const token = await ask("Bot Token");
  if (!token) {
    console.log("  ⚠ トークンが空です。後で .env に直接設定できます。");
  }

  const guildId = await ask("サーバー(Guild) ID");
  if (!guildId) {
    console.log("  ⚠ Guild IDが空です。後で .env に直接設定できます。");
    console.log(
      '  取得方法: Discord設定 > 詳細設定 > 開発者モード ON → サーバー右クリック > "サーバーIDをコピー"'
    );
  }

  console.log();
  return { token: token || "", guildId: guildId || "" };
}

async function setupLLM(): Promise<{
  provider: LLMProvider;
  apiKey: string;
  model: string;
}> {
  console.log("── LLM プロバイダー設定 ──");
  console.log();

  const provider = (await select(
    "使用するLLMプロバイダーを選択:",
    LLM_PROVIDERS
  )) as LLMProvider;

  const keyHints: Record<LLMProvider, string> = {
    anthropic: "https://console.anthropic.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    gemini: "https://aistudio.google.com/apikey",
    openrouter: "https://openrouter.ai/keys",
    groq: "https://console.groq.com/keys",
  };

  console.log();
  console.log(`  APIキーの取得: ${keyHints[provider]}`);

  const apiKey = await ask(`${provider} APIキー`);
  if (!apiKey) {
    console.log("  ⚠ APIキーが空です。後で .env に直接設定できます。");
  }

  const model = await ask("モデル名 (空欄でデフォルト)");

  console.log();
  return { provider, apiKey: apiKey || "", model };
}

function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

function writeEnvFile(config: {
  discord: { token: string; guildId: string };
  llm: { provider: LLMProvider; apiKey: string; model: string };
  encryptionKey: string;
}) {
  const apiKeyEntries = LLM_PROVIDERS.map((p) => {
    const key =
      p === config.llm.provider ? config.llm.apiKey : "";
    const envName = `${p.toUpperCase()}_API_KEY`;
    return `${envName}=${key}`;
  }).join("\n");

  const content = `# Discord
DISCORD_TOKEN=${config.discord.token}
DISCORD_GUILD_ID=${config.discord.guildId}

# LLM Provider: ${LLM_PROVIDERS.join(" | ")}
LLM_PROVIDER=${config.llm.provider}

# API Keys
${apiKeyEntries}

# LLM Model (空欄でデフォルト)
LLM_MODEL=${config.llm.model}

# Data encryption key
ENCRYPTION_KEY=${config.encryptionKey}
`;

  writeFileSync(ENV_PATH, content, "utf-8");
}

async function main() {
  header();

  if (existsSync(ENV_PATH)) {
    const overwrite = await confirm(
      ".env が既に存在します。上書きしますか?"
    );
    if (!overwrite) {
      console.log("  セットアップを中止しました。");
      rl.close();
      return;
    }
    console.log();
  }

  const discord = await setupDiscord();
  const llm = await setupLLM();
  const encryptionKey = generateEncryptionKey();

  writeEnvFile({ discord, llm, encryptionKey });

  console.log("── セットアップ完了 ──");
  console.log();
  console.log("  .env ファイルを作成しました。");
  console.log();
  console.log("  次のステップ:");
  console.log("    1. npm run setup:channels  → Discordチャンネル自動作成");
  console.log("    2. npm run dev             → Bot起動");
  console.log();

  rl.close();
}

main().catch((err) => {
  console.error("セットアップエラー:", err);
  rl.close();
  process.exit(1);
});
