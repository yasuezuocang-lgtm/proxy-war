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
  console.log("  このシステムは2体のBotを使います:");
  console.log("  - Bot A: ユーザーAの代理（DMで本音を受け取る）");
  console.log("  - Bot B: ユーザーBの代理（DMで本音を受け取る）");
  console.log("  - 共有サーバー: Bot同士が #talk で議論する場所");
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

function botGuide() {
  console.log("  Discord Developer Portal でBotを作成:");
  console.log("  https://discord.com/developers/applications");
  console.log();
  console.log("  各Botに必要な設定:");
  console.log("    Privileged Gateway Intents:");
  console.log("      - Message Content Intent を有効化");
  console.log("    Bot Permissions:");
  console.log("      - Send Messages / Read Message History / View Channels");
  console.log("    ※ Bot Aと Bot B は別々のアプリケーションとして作成");
  console.log();
}

async function setupBots(): Promise<{
  botA: { token: string; name: string };
  botB: { token: string; name: string };
}> {
  console.log("── Bot A（ユーザーAの代理）──");
  console.log();
  botGuide();

  const tokenA = await ask("Bot A のトークン");
  const nameA = await ask("Bot A の表示名", "代理Bot A");
  console.log();

  console.log("── Bot B（ユーザーBの代理）──");
  console.log();

  const tokenB = await ask("Bot B のトークン");
  const nameB = await ask("Bot B の表示名", "代理Bot B");
  console.log();

  if (!tokenA || !tokenB) {
    console.log("  ⚠ トークンが空のBotがあります。後で .env に直接設定できます。");
    console.log();
  }

  return {
    botA: { token: tokenA || "", name: nameA },
    botB: { token: tokenB || "", name: nameB },
  };
}

async function setupTalkServer(): Promise<string> {
  console.log("── 共有サーバー（Bot同士の対話場所）──");
  console.log();
  console.log("  Bot A と Bot B の両方をこのサーバーに招待してください。");
  console.log("  ここに #talk チャンネルが作られ、代理対話が行われます。");
  console.log();
  console.log("  Guild IDの取得方法:");
  console.log('    Discord > 設定 > 詳細設定 > 開発者モード ON');
  console.log('    → サーバー右クリック > "サーバーIDをコピー"');
  console.log();

  const guildId = await ask("共有サーバーの Guild ID");
  if (!guildId) {
    console.log("  ⚠ Guild IDが空です。後で .env に直接設定できます。");
  }
  console.log();
  return guildId || "";
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

function writeEnvFile(config: {
  botA: { token: string; name: string };
  botB: { token: string; name: string };
  talkGuildId: string;
  llm: { provider: LLMProvider; apiKey: string; model: string };
  encryptionKey: string;
}) {
  const apiKeyEntries = LLM_PROVIDERS.map((p) => {
    const key = p === config.llm.provider ? config.llm.apiKey : "";
    const envName = `${p.toUpperCase()}_API_KEY`;
    return `${envName}=${key}`;
  }).join("\n");

  const content = `# Bot A (ユーザーAの代理Bot)
BOT_A_TOKEN=${config.botA.token}
BOT_A_NAME=${config.botA.name}

# Bot B (ユーザーBの代理Bot)
BOT_B_TOKEN=${config.botB.token}
BOT_B_NAME=${config.botB.name}

# 共有サーバー (Bot同士が対話する場所)
TALK_GUILD_ID=${config.talkGuildId}

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

  const bots = await setupBots();
  const talkGuildId = await setupTalkServer();
  const llm = await setupLLM();
  const encryptionKey = randomBytes(32).toString("hex");

  writeEnvFile({ ...bots, talkGuildId, llm, encryptionKey });

  console.log("── セットアップ完了 ──");
  console.log();
  console.log("  .env ファイルを作成しました。");
  console.log();
  console.log("  次のステップ:");
  console.log("    1. Bot A と Bot B を共有サーバーに招待");
  console.log("    2. npm run setup:channels  → #talk チャンネル自動作成");
  console.log("    3. npm run dev             → 両Bot起動");
  console.log();
  console.log("  使い方:");
  console.log("    - ユーザーA → Bot A にDMで本音を送る");
  console.log("    - ユーザーB → Bot B にDMで本音を送る");
  console.log("    - 両者の準備が整ったら #talk で代理対話が始まる");
  console.log();

  rl.close();
}

main().catch((err) => {
  console.error("セットアップエラー:", err);
  rl.close();
  process.exit(1);
});
