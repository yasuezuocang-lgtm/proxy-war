import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEncryptionKey } from "./setup.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "proxy-war-setup-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveEncryptionKey: .env が存在しない場合、32 bytes の hex 鍵を新規生成", () => {
  withTempDir((dir) => {
    const envPath = join(dir, ".env");
    const result = resolveEncryptionKey(envPath);
    assert.equal(result.generated, true);
    assert.match(result.key, /^[0-9a-f]{64}$/);
  });
});

test("resolveEncryptionKey: 既存 .env の ENCRYPTION_KEY を保持する（上書きしない）", () => {
  withTempDir((dir) => {
    const envPath = join(dir, ".env");
    const existingKey = "a".repeat(64);
    writeFileSync(
      envPath,
      `BOT_A_TOKEN=xxx\nENCRYPTION_KEY=${existingKey}\nLLM_PROVIDER=anthropic\n`
    );
    const result = resolveEncryptionKey(envPath);
    assert.equal(result.generated, false);
    assert.equal(result.key, existingKey);
  });
});

test("resolveEncryptionKey: ENCRYPTION_KEY の行が無ければ新規生成", () => {
  withTempDir((dir) => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "BOT_A_TOKEN=xxx\nLLM_PROVIDER=anthropic\n");
    const result = resolveEncryptionKey(envPath);
    assert.equal(result.generated, true);
    assert.match(result.key, /^[0-9a-f]{64}$/);
  });
});

test("resolveEncryptionKey: ENCRYPTION_KEY が空文字なら新規生成", () => {
  withTempDir((dir) => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ENCRYPTION_KEY=\nBOT_A_TOKEN=xxx\n");
    const result = resolveEncryptionKey(envPath);
    assert.equal(result.generated, true);
    assert.match(result.key, /^[0-9a-f]{64}$/);
  });
});

test("resolveEncryptionKey: 生成鍵は呼ぶたびに異なる（乱数性）", () => {
  withTempDir((dir) => {
    const envPath = join(dir, ".env");
    const r1 = resolveEncryptionKey(envPath);
    const r2 = resolveEncryptionKey(envPath);
    assert.equal(r1.generated, true);
    assert.equal(r2.generated, true);
    assert.notEqual(r1.key, r2.key);
  });
});
