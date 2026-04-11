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
  discord: {
    token: string;
    guildId: string;
  };
  llm: {
    provider: LLMProvider;
    apiKey: string;
    model: string;
  };
  encryptionKey: string;
}

export function loadConfig(): Config {
  const provider = (process.env.LLM_PROVIDER || "anthropic") as LLMProvider;

  if (!LLM_PROVIDERS.includes(provider)) {
    throw new Error(
      `未対応のLLMプロバイダー: ${provider}\n対応: ${LLM_PROVIDERS.join(", ")}`
    );
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_TOKEN が設定されていません。npm run setup を実行してください。"
    );
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error(
      "DISCORD_GUILD_ID が設定されていません。npm run setup を実行してください。"
    );
  }

  const apiKeyEnv = API_KEY_ENV[provider];
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${apiKeyEnv} が設定されていません。npm run setup を実行してください。`
    );
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      "ENCRYPTION_KEY が設定されていません。npm run setup を実行してください。"
    );
  }

  return {
    discord: { token, guildId },
    llm: {
      provider,
      apiKey,
      model: process.env.LLM_MODEL || DEFAULT_MODELS[provider],
    },
    encryptionKey,
  };
}
