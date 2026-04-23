import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

import { EncryptedSessionRepository } from "./EncryptedSessionRepository.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Appeal } from "../../domain/entities/Appeal.js";

function makeKey(): string {
  return randomBytes(32).toString("hex");
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "proxy-war-enc-"));
}

function seedSession(id: string, guildId: string): Session {
  const policy = new SessionPolicy({
    maxTurns: 6,
    maxHearingsPerSide: 1,
    hearingTimeoutMs: 123,
    appealTimeoutMs: 456,
    maxAppeals: 1,
  });
  const session = new Session({ id, guildId, policy, createdAt: 1000 });
  session.phase = "debating";
  session.topic = "お題テスト";
  session.appealableSides = ["A"];
  session.participants.A.phase = "ready";
  session.participants.A.brief = {
    rawInputs: ["生本音A"],
    structuredContext: "整理A",
    summary: "要約A",
    confirmedAt: 200,
    goal: "勝つ",
  };
  session.participants.A.followUpCount = 2;
  session.participants.B.phase = "ready";
  session.participants.B.brief = {
    rawInputs: ["生本音B"],
    structuredContext: "整理B",
    summary: "要約B",
    confirmedAt: 300,
    goal: null,
  };

  const round = session.createRound("district");
  round.turns.push({ speakerSide: "A", message: "おらー", createdAt: 400 });
  round.turns.push({ speakerSide: "B", message: "うるせー", createdAt: 500 });
  round.hearings.push({
    requestedBy: "A",
    targetSide: "A",
    question: "いつ起きた?",
    context: "事実確認",
    createdAt: 600,
    answeredAt: 700,
    answer: "昨日",
  });
  const judgment: Judgment = {
    winner: "A",
    criteria: [{ name: "論理", scoreA: 4, scoreB: 2, reason: "一貫性A" }],
    totalA: 4,
    totalB: 2,
    summary: "A 優位",
    zopa: "謝罪",
    wisdom: "早めに言え",
    angerA: "放置された",
    angerB: "責められた",
  };
  round.judgment = judgment;
  const appeal: Appeal = {
    appellantSide: "B",
    content: "納得いかない",
    createdAt: 800,
    appealedBy: "B",
    appealedAt: 800,
    courtLevel: "high",
  };
  round.appeal = appeal;

  session.activeHearing = {
    requestedBy: "B",
    targetSide: "B",
    question: "なぜ?",
    context: "詰め",
    createdAt: 900,
    answeredAt: null,
    answer: null,
  };
  return session;
}

test("EncryptedSessionRepository: 空鍵だと構築時にエラー", () => {
  assert.throws(
    () =>
      new EncryptedSessionRepository({
        encryptionKey: "",
        dataDir: makeTempDir(),
      }),
    /ENCRYPTION_KEY/
  );
});

test("EncryptedSessionRepository: 不正長の鍵だと構築時にエラー", () => {
  assert.throws(
    () =>
      new EncryptedSessionRepository({
        encryptionKey: "short",
        dataDir: makeTempDir(),
      }),
    /64 文字の hex/
  );
});

test("EncryptedSessionRepository: save→findById でセッションが復元される", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  const original = seedSession("s1", "guild-1");
  await repo.save(original);

  const loaded = await repo.findById("s1");
  assert.ok(loaded, "findById should return the session");
  assert.equal(loaded!.id, "s1");
  assert.equal(loaded!.guildId, "guild-1");
  assert.equal(loaded!.phase, "debating");
  assert.equal(loaded!.topic, "お題テスト");
  assert.deepEqual(loaded!.appealableSides, ["A"]);

  // policy が SessionPolicy として復元される（型検査込み）
  assert.ok(loaded!.policy instanceof SessionPolicy);
  assert.equal(loaded!.policy.maxTurns, 6);
  assert.equal(loaded!.policy.maxAppeals, 1);

  // participant の brief が保持されている
  assert.equal(loaded!.participants.A.phase, "ready");
  assert.deepEqual(loaded!.participants.A.brief.rawInputs, ["生本音A"]);
  assert.equal(loaded!.participants.A.brief.goal, "勝つ");
  assert.equal(loaded!.participants.A.followUpCount, 2);
  assert.equal(loaded!.participants.B.brief.summary, "要約B");

  // round と判決と異議が保持されている
  assert.equal(loaded!.rounds.length, 1);
  const round = loaded!.rounds[0];
  assert.equal(round.courtLevel, "district");
  assert.equal(round.turns.length, 2);
  assert.equal(round.turns[1].message, "うるせー");
  assert.equal(round.judgment?.winner, "A");
  assert.equal(round.judgment?.criteria[0].name, "論理");
  assert.equal(round.appeal?.courtLevel, "high");
  assert.equal(round.hearings[0].answer, "昨日");
  assert.equal(loaded!.activeHearing?.question, "なぜ?");
});

test("EncryptedSessionRepository: ファイルは暗号化されていて平文で含まれない", async () => {
  const tmp = makeTempDir();
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: tmp,
  });
  const session = seedSession("s2", "guild-2");
  await repo.save(session);

  const raw = readFileSync(join(tmp, "s2.enc"), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.match(parsed.iv, /^[A-Za-z0-9+/=]+$/);
  assert.match(parsed.authTag, /^[A-Za-z0-9+/=]+$/);
  assert.match(parsed.ciphertext, /^[A-Za-z0-9+/=]+$/);
  // 平文キーワードがファイルに出ない
  assert.ok(!raw.includes("お題テスト"));
  assert.ok(!raw.includes("生本音A"));
});

test("EncryptedSessionRepository: 鍵が違うと復号できず active 検索で無視される", async () => {
  const tmp = makeTempDir();
  const keyA = makeKey();
  const keyB = makeKey();
  const repoA = new EncryptedSessionRepository({
    encryptionKey: keyA,
    dataDir: tmp,
  });
  await repoA.save(seedSession("s3", "guild-3"));

  const repoB = new EncryptedSessionRepository({
    encryptionKey: keyB,
    dataDir: tmp,
  });
  const active = await repoB.findActiveByGuildId("guild-3");
  assert.equal(active, null);
});

test("EncryptedSessionRepository: findActiveByGuildId は archived を除外", async () => {
  const tmp = makeTempDir();
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: tmp,
  });
  const alive = seedSession("alive", "guild-x");
  const gone = seedSession("gone", "guild-x");
  gone.phase = "archived";
  await repo.save(alive);
  await repo.save(gone);

  const active = await repo.findActiveByGuildId("guild-x");
  assert.ok(active);
  assert.equal(active!.id, "alive");
});

test("EncryptedSessionRepository: findActiveByGuildId は最新の createdAt を優先", async () => {
  const tmp = makeTempDir();
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: tmp,
  });
  const older = seedSession("older", "guild-y");
  const newer = seedSession("newer", "guild-y");
  (newer as unknown as { createdAt: number }).createdAt = 9999;
  await repo.save(older);
  await repo.save(newer);

  const active = await repo.findActiveByGuildId("guild-y");
  assert.equal(active!.id, "newer");
});

test("EncryptedSessionRepository: archive は phase を archived に更新", async () => {
  const tmp = makeTempDir();
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: tmp,
  });
  await repo.save(seedSession("s4", "guild-4"));
  await repo.archive("s4");
  const loaded = await repo.findById("s4");
  assert.equal(loaded!.phase, "archived");
  const active = await repo.findActiveByGuildId("guild-4");
  assert.equal(active, null);
});

test("EncryptedSessionRepository: delete はファイルを消す", async () => {
  const tmp = makeTempDir();
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: tmp,
  });
  await repo.save(seedSession("s5", "guild-5"));
  const path = join(tmp, "s5.enc");
  assert.ok(existsSync(path));
  await repo.delete("s5");
  assert.ok(!existsSync(path));
  const loaded = await repo.findById("s5");
  assert.equal(loaded, null);
});

test("EncryptedSessionRepository: findById で存在しない ID は null", async () => {
  const repo = new EncryptedSessionRepository({
    encryptionKey: makeKey(),
    dataDir: makeTempDir(),
  });
  assert.equal(await repo.findById("missing"), null);
});
