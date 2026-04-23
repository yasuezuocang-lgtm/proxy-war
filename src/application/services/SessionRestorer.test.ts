import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

import { SessionRestorer } from "./SessionRestorer.js";
import { EncryptedSessionRepository } from "../../infrastructure/persistence/EncryptedSessionRepository.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { MessageGateway } from "../ports/MessageGateway.js";

function makeKey(): string {
  return randomBytes(32).toString("hex");
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "proxy-war-restore-"));
}

class RecordingMessageGateway implements MessageGateway {
  readonly dms: { side: "A" | "B"; message: string }[] = [];
  readonly talks: { message: string; speaker: "A" | "B" | "system" }[] = [];

  async sendDm(side: "A" | "B", message: string): Promise<void> {
    this.dms.push({ side, message });
  }

  async sendTalkMessage(
    message: string,
    speaker: "A" | "B" | "system" = "system"
  ): Promise<void> {
    this.talks.push({ message, speaker });
  }

  async sendTyping(): Promise<void> {}
}

function makeSession(id: string, guildId: string): Session {
  return new Session({
    id,
    guildId,
    policy: new SessionPolicy({
      maxTurns: 4,
      maxHearingsPerSide: 1,
      hearingTimeoutMs: 1000,
      appealTimeoutMs: 1000,
      maxAppeals: 1,
    }),
  });
}

test("SessionRestorer: active セッション不在なら none を返す", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  const result = await restorer.restore("guild-x");
  assert.deepEqual(result, { type: "none" });
  assert.equal(gateway.talks.length, 0);
});

test("SessionRestorer: preparing は kept 扱いで保持", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  const session = makeSession("s-prep", "guild-prep");
  session.phase = "preparing";
  await repo.save(session);

  const result = await restorer.restore("guild-prep");
  assert.deepEqual(result, {
    type: "kept",
    sessionId: "s-prep",
    phase: "preparing",
  });
  assert.equal(gateway.talks.length, 0);

  const stillActive = await repo.findActiveByGuildId("guild-prep");
  assert.equal(stillActive?.phase, "preparing");
});

test("SessionRestorer: ready も kept（DM 待ちで通常フローに戻れる）", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  const session = makeSession("s-ready", "guild-ready");
  session.phase = "ready";
  await repo.save(session);

  const result = await restorer.restore("guild-ready");
  assert.equal(result.type, "kept");
  if (result.type === "kept") {
    assert.equal(result.phase, "ready");
  }
  assert.equal(gateway.talks.length, 0);
});

test("SessionRestorer: debating は archive され、#talk に中断告知が流れる", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  const session = makeSession("s-debating", "guild-d");
  session.phase = "debating";
  session.createRound("district");
  await repo.save(session);

  const result = await restorer.restore("guild-d");
  assert.deepEqual(result, {
    type: "archived",
    sessionId: "s-debating",
    interruptedPhase: "debating",
  });

  assert.equal(gateway.talks.length, 1);
  assert.match(gateway.talks[0].message, /再起動/);
  assert.match(gateway.talks[0].message, /中断/);

  const loaded = await repo.findById("s-debating");
  assert.equal(loaded?.phase, "archived");
  const active = await repo.findActiveByGuildId("guild-d");
  assert.equal(active, null);
});

test("SessionRestorer: judging / hearing / appeal_pending も archive", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  for (const [id, phase] of [
    ["s-j", "judging"],
    ["s-h", "hearing"],
    ["s-ap", "appeal_pending"],
  ] as const) {
    const session = makeSession(id, `guild-${id}`);
    session.phase = phase;
    session.createRound("district");
    await repo.save(session);

    const result = await restorer.restore(`guild-${id}`);
    assert.equal(result.type, "archived", `${phase} should be archived`);
    if (result.type === "archived") {
      assert.equal(result.interruptedPhase, phase);
    }
    const loaded = await repo.findById(id);
    assert.equal(loaded?.phase, "archived");
  }

  // 3 セッション分の告知が流れているはず
  assert.equal(gateway.talks.length, 3);
});

test("SessionRestorer: finished は kept で告知なし", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(repo, gateway);

  const session = makeSession("s-fin", "guild-fin");
  session.phase = "finished";
  await repo.save(session);

  const result = await restorer.restore("guild-fin");
  assert.equal(result.type, "kept");
  assert.equal(gateway.talks.length, 0);
});

test("SessionRestorer: Encrypted 保存→新 repo インスタンスからも復元できる", async () => {
  // Bot 再起動 = 新しい repository インスタンスが同じ dataDir/encryptionKey を読む状況。
  // これが P1-19 の本来の目的（プロセス跨ぎで session が生きている）。
  const key = makeKey();
  const dir = makeTempDir();

  const writerRepo = new EncryptedSessionRepository({
    encryptionKey: key,
    dataDir: dir,
  });
  const session = makeSession("s-cross", "guild-cross");
  session.phase = "preparing";
  session.participants.A.brief.rawInputs = ["本音A"];
  await writerRepo.save(session);

  // 再起動相当: 別インスタンスで同じ鍵/dir を開く
  const readerRepo = new EncryptedSessionRepository({
    encryptionKey: key,
    dataDir: dir,
  });
  const gateway = new RecordingMessageGateway();
  const restorer = new SessionRestorer(readerRepo, gateway);

  const result = await restorer.restore("guild-cross");
  assert.equal(result.type, "kept");
  if (result.type === "kept") {
    assert.equal(result.sessionId, "s-cross");
    assert.equal(result.phase, "preparing");
  }

  const reloaded = await readerRepo.findActiveByGuildId("guild-cross");
  assert.deepEqual(reloaded?.participants.A.brief.rawInputs, ["本音A"]);
});
