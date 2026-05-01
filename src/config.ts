import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 環境変数読み込みポリシー:
// デフォルトで `.env` を読み、`NODE_ENV=test` または `--test` フラグ指定時のみ
// `.env.test` を override 読み込みして上書きマージする。
// 全ての定数は config モジュール経由で読むこと（直接 process.env を叩かない）。
export function loadEnvFiles(options?: { baseDir?: string }): void {
  const base = options?.baseDir ?? resolve(__dirname, "..");
  loadEnv({ path: resolve(base, ".env") });

  const testMode =
    process.env.NODE_ENV === "test" || process.argv.includes("--test");
  if (testMode) {
    loadEnv({ path: resolve(base, ".env.test"), override: true });
  }
}

loadEnvFiles();

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

// 数値・閾値を一元管理する型。
// 既存の SubmitInputUseCase / StartSessionUseCase / DebateCoordinator は
// まだ自前のハードコード値を持っている。将来的にこれらを
// loadAppConfig() 経由に差し替える。
export interface AppConfig {
  debate: {
    maxTurnsPerRound: number;
    turnDelayMs: number;
    inputDebounceMs: number;
  };
  hearing: {
    maxHearingsPerSide: number;
    maxHearingFollowups: number;
    hearingTimeoutMs: number;
  };
  appeal: {
    maxAppeals: number;
    appealWindowMs: number;
  };
  input: {
    maxProbeQuestions: number;
    minInputLength: number;
  };
  session: {
    idleTimeoutMs: number;
  };
  typing: {
    refreshIntervalMs: number;
  };
  encryption: {
    algorithm: string;
  };
}

// 本番デフォルト値。`.env` が未定義の場合はこれが使われる。
export const APP_CONFIG_DEFAULTS: AppConfig = {
  debate: {
    maxTurnsPerRound: 8,
    turnDelayMs: 3000,
    inputDebounceMs: 10000,
  },
  hearing: {
    maxHearingsPerSide: 2,
    maxHearingFollowups: 2,
    hearingTimeoutMs: 300000,
  },
  appeal: {
    maxAppeals: 2,
    appealWindowMs: 600000,
  },
  input: {
    maxProbeQuestions: 3,
    minInputLength: 50,
  },
  session: {
    idleTimeoutMs: 86400000,
  },
  typing: {
    refreshIntervalMs: 5000,
  },
  encryption: {
    algorithm: "aes-256-gcm",
  },
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `${name} は0以上の整数で指定してください（現在: ${raw}）`
    );
  }
  return n;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

export function loadAppConfig(): AppConfig {
  return {
    debate: {
      maxTurnsPerRound: readPositiveInt(
        "MAX_TURNS_PER_ROUND",
        APP_CONFIG_DEFAULTS.debate.maxTurnsPerRound
      ),
      turnDelayMs: readPositiveInt(
        "TURN_DELAY_MS",
        APP_CONFIG_DEFAULTS.debate.turnDelayMs
      ),
      inputDebounceMs: readPositiveInt(
        "INPUT_DEBOUNCE_MS",
        APP_CONFIG_DEFAULTS.debate.inputDebounceMs
      ),
    },
    hearing: {
      maxHearingsPerSide: readPositiveInt(
        "MAX_HEARINGS_PER_SIDE",
        APP_CONFIG_DEFAULTS.hearing.maxHearingsPerSide
      ),
      maxHearingFollowups: readPositiveInt(
        "MAX_HEARING_FOLLOWUPS",
        APP_CONFIG_DEFAULTS.hearing.maxHearingFollowups
      ),
      hearingTimeoutMs: readPositiveInt(
        "HEARING_TIMEOUT_MS",
        APP_CONFIG_DEFAULTS.hearing.hearingTimeoutMs
      ),
    },
    appeal: {
      maxAppeals: readPositiveInt(
        "MAX_APPEALS",
        APP_CONFIG_DEFAULTS.appeal.maxAppeals
      ),
      appealWindowMs: readPositiveInt(
        "APPEAL_WINDOW_MS",
        APP_CONFIG_DEFAULTS.appeal.appealWindowMs
      ),
    },
    input: {
      maxProbeQuestions: readPositiveInt(
        "MAX_PROBE_QUESTIONS",
        APP_CONFIG_DEFAULTS.input.maxProbeQuestions
      ),
      minInputLength: readPositiveInt(
        "MIN_INPUT_LENGTH",
        APP_CONFIG_DEFAULTS.input.minInputLength
      ),
    },
    session: {
      idleTimeoutMs: readPositiveInt(
        "SESSION_IDLE_TIMEOUT_MS",
        APP_CONFIG_DEFAULTS.session.idleTimeoutMs
      ),
    },
    typing: {
      refreshIntervalMs: readPositiveInt(
        "TYPING_REFRESH_INTERVAL_MS",
        APP_CONFIG_DEFAULTS.typing.refreshIntervalMs
      ),
    },
    encryption: {
      algorithm: readString(
        "ENCRYPTION_ALGORITHM",
        APP_CONFIG_DEFAULTS.encryption.algorithm
      ),
    },
  };
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
