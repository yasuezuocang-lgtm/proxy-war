import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_CONFIG_DEFAULTS,
  loadAppConfig,
  loadEnvFiles,
} from "./config.js";

const SPEC_ENV_KEYS = [
  "MAX_TURNS_PER_ROUND",
  "TURN_DELAY_MS",
  "INPUT_DEBOUNCE_MS",
  "MAX_HEARINGS_PER_SIDE",
  "MAX_HEARING_FOLLOWUPS",
  "HEARING_TIMEOUT_MS",
  "MAX_APPEALS",
  "APPEAL_WINDOW_MS",
  "MAX_PROBE_QUESTIONS",
  "MIN_INPUT_LENGTH",
  "SESSION_IDLE_TIMEOUT_MS",
  "TYPING_REFRESH_INTERVAL_MS",
  "ENCRYPTION_ALGORITHM",
] as const;

function withClearedEnv<T>(fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of SPEC_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of SPEC_ENV_KEYS) {
      const original = snapshot[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

test("loadAppConfig: env 未設定なら SPEC §9 の本番デフォルト値を返す", () => {
  withClearedEnv(() => {
    const cfg = loadAppConfig();
    assert.deepEqual(cfg, APP_CONFIG_DEFAULTS);
    assert.equal(cfg.debate.maxTurnsPerRound, 8);
    assert.equal(cfg.input.minInputLength, 50);
    assert.equal(cfg.appeal.appealWindowMs, 600000);
    assert.equal(cfg.encryption.algorithm, "aes-256-gcm");
  });
});

test("loadAppConfig: 数値の env が指定されたら整数として読み込む", () => {
  withClearedEnv(() => {
    process.env.MAX_TURNS_PER_ROUND = "2";
    process.env.HEARING_TIMEOUT_MS = "10000";
    process.env.APPEAL_WINDOW_MS = "5000";
    process.env.MIN_INPUT_LENGTH = "10";
    const cfg = loadAppConfig();
    assert.equal(cfg.debate.maxTurnsPerRound, 2);
    assert.equal(cfg.hearing.hearingTimeoutMs, 10000);
    assert.equal(cfg.appeal.appealWindowMs, 5000);
    assert.equal(cfg.input.minInputLength, 10);
  });
});

test("loadAppConfig: 文字列の env（暗号化アルゴリズム）も上書きできる", () => {
  withClearedEnv(() => {
    process.env.ENCRYPTION_ALGORITHM = "aes-128-gcm";
    const cfg = loadAppConfig();
    assert.equal(cfg.encryption.algorithm, "aes-128-gcm");
  });
});

test("loadAppConfig: 不正な数値（負・小数・非数値）は明示的にエラー", () => {
  withClearedEnv(() => {
    process.env.MAX_TURNS_PER_ROUND = "abc";
    assert.throws(() => loadAppConfig(), /MAX_TURNS_PER_ROUND/);
  });
  withClearedEnv(() => {
    process.env.MAX_TURNS_PER_ROUND = "-1";
    assert.throws(() => loadAppConfig(), /MAX_TURNS_PER_ROUND/);
  });
  withClearedEnv(() => {
    process.env.MAX_TURNS_PER_ROUND = "1.5";
    assert.throws(() => loadAppConfig(), /MAX_TURNS_PER_ROUND/);
  });
});

test("loadAppConfig: 空文字列の env はデフォルト扱い（未指定相当）", () => {
  withClearedEnv(() => {
    process.env.MAX_TURNS_PER_ROUND = "";
    const cfg = loadAppConfig();
    assert.equal(
      cfg.debate.maxTurnsPerRound,
      APP_CONFIG_DEFAULTS.debate.maxTurnsPerRound
    );
  });
});

function withTempEnvDir(
  files: Record<string, string>,
  fn: (dir: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), "proxy-war-env-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.NODE_ENV;
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = original;
    }
  }
}

test("loadEnvFiles: NODE_ENV=test 時は .env.test が .env を上書きする", () => {
  withClearedEnv(() => {
    withTempEnvDir(
      {
        ".env": "MAX_TURNS_PER_ROUND=8\nMIN_INPUT_LENGTH=50\n",
        ".env.test": "MAX_TURNS_PER_ROUND=2\nAPPEAL_WINDOW_MS=5000\n",
      },
      (dir) => {
        withNodeEnv("test", () => {
          loadEnvFiles({ baseDir: dir });
          const cfg = loadAppConfig();
          // .env.test の値が勝つ
          assert.equal(cfg.debate.maxTurnsPerRound, 2);
          assert.equal(cfg.appeal.appealWindowMs, 5000);
          // .env にしかない値はそのまま残る
          assert.equal(cfg.input.minInputLength, 50);
        });
      }
    );
  });
});

test("loadEnvFiles: NODE_ENV が test 以外なら .env.test を無視", () => {
  withClearedEnv(() => {
    withTempEnvDir(
      {
        ".env": "MAX_TURNS_PER_ROUND=8\n",
        ".env.test": "MAX_TURNS_PER_ROUND=2\n",
      },
      (dir) => {
        withNodeEnv("production", () => {
          loadEnvFiles({ baseDir: dir });
          const cfg = loadAppConfig();
          assert.equal(cfg.debate.maxTurnsPerRound, 8);
        });
      }
    );
  });
});

test("loadEnvFiles: NODE_ENV=test でも .env.test が無ければ .env だけで動く", () => {
  withClearedEnv(() => {
    withTempEnvDir(
      {
        ".env": "MAX_TURNS_PER_ROUND=7\n",
      },
      (dir) => {
        withNodeEnv("test", () => {
          assert.doesNotThrow(() => loadEnvFiles({ baseDir: dir }));
          const cfg = loadAppConfig();
          assert.equal(cfg.debate.maxTurnsPerRound, 7);
        });
      }
    );
  });
});
