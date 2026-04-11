import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "groq",
] as const;

export type LLMProvider = (typeof LLM_PROVIDERS)[number];

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  openrouter: "anthropic/claude-sonnet-4-20250514",
  groq: "llama-3.3-70b-versatile",
};

const API_KEY_ENV: Record<LLMProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
};

export interface Config {
  botA: {
    token: string;
    name: string;
  };
  botB: {
    token: string;
    name: string;
  };
  talkGuildId: string;
  llm: {
    provider: LLMProvider;
    apiKey: string;
    model: string;
  };
  encryptionKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} が設定されていません。npm run setup を実行してください。`
    );
  }
  return value;
}

export function loadConfig(): Config {
  const provider = (process.env.LLM_PROVIDER || "anthropic") as LLMProvider;

  if (!LLM_PROVIDERS.includes(provider)) {
    throw new Error(
      `未対応のLLMプロバイダー: ${provider}\n対応: ${LLM_PROVIDERS.join(", ")}`
    );
  }

  const apiKeyEnv = API_KEY_ENV[provider];

  return {
    botA: {
      token: requireEnv("BOT_A_TOKEN"),
      name: process.env.BOT_A_NAME || "代理Bot A",
    },
    botB: {
      token: requireEnv("BOT_B_TOKEN"),
      name: process.env.BOT_B_NAME || "代理Bot B",
    },
    talkGuildId: requireEnv("TALK_GUILD_ID"),
    llm: {
      provider,
      apiKey: requireEnv(apiKeyEnv),
      model: process.env.LLM_MODEL || DEFAULT_MODELS[provider],
    },
    encryptionKey: requireEnv("ENCRYPTION_KEY"),
  };
}
