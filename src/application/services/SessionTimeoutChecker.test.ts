import test from "node:test";
import assert from "node:assert/strict";

import { SessionTimeoutChecker } from "./SessionTimeoutChecker.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import type { SessionPhase } from "../../domain/value-objects/SessionPhase.js";

class RecordingMessageGateway implements MessageGateway {
  readonly dms: { side: "A" | "B"; message: string }[] = [];
  readonly talks: string[] = [];
  failOnSides: ("A" | "B")[] = [];

  async sendDm(side: "A" | "B", message: string): Promise<void> {
    if (this.failOnSides.includes(side)) {
      throw new Error(`${side} DM 未登録`);
    }
    this.dms.push({ side, message });
  }

  async sendTalkMessage(message: string): Promise<void> {
    this.talks.push(message);
  }

  async sendTyping(): Promise<void> {}
}

class StubSessionRepository
  implements Pick<SessionRepository, "archive">
{
  readonly archivedIds: string[] = [];
  failOnIds: string[] = [];

  async archive(sessionId: string): Promise<void> {
    if (this.failOnIds.includes(sessionId)) {
      throw new Error(`archive 失敗: ${sessionId}`);
    }
    this.archivedIds.push(sessionId);
  }
}

function makeSession(params: {
  id: string;
  guildId?: string;
  phase?: SessionPhase;
  lastActivityAt: number;
}): Session {
  const session = new Session({
    id: params.id,
    guildId: params.guildId ?? `guild-${params.id}`,
    policy: new SessionPolicy({
      maxTurns: 2,
      maxHearingsPerSide: 1,
      hearingTimeoutMs: 1000,
      appealTimeoutMs: 1000,
      maxAppeals: 1,
    }),
    lastActivityAt: params.lastActivityAt,
  });
  if (params.phase) {
    session.phase = params.phase;
  }
  return session;
}

test("idleTimeoutMs が 0 以下なら construct でエラー", () => {
  const noop = async () => [];
  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();
  assert.throws(
    () =>
      new SessionTimeoutChecker({
        listActiveSessions: noop,
        sessionRepository: repo,
        messageGateway: gateway,
        idleTimeoutMs: 0,
      }),
    /idleTimeoutMs/
  );
  assert.throws(
    () =>
      new SessionTimeoutChecker({
        listActiveSessions: noop,
        sessionRepository: repo,
        messageGateway: gateway,
        idleTimeoutMs: -1,
      }),
    /idleTimeoutMs/
  );
});

test("checkIntervalMs が 0 以下なら construct でエラー", () => {
  assert.throws(
    () =>
      new SessionTimeoutChecker({
        listActiveSessions: async () => [],
        sessionRepository: new StubSessionRepository(),
        messageGateway: new RecordingMessageGateway(),
        idleTimeoutMs: 1000,
        checkIntervalMs: 0,
      }),
    /checkIntervalMs/
  );
});

test("lastActivityAt が idleTimeoutMs を超えたセッションをアーカイブし両者+#talk に通知", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000; // 1 分
  const idle = makeSession({
    id: "idle",
    lastActivityAt: now - idleTimeoutMs - 1, // ぎりぎり超過
    phase: "debating",
  });
  const fresh = makeSession({
    id: "fresh",
    lastActivityAt: now - 1_000, // 閾値以内
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();
  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => [idle, fresh],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    now: () => now,
  });

  const result = await checker.check();

  assert.deepEqual(result.archivedSessionIds, ["idle"]);
  assert.equal(result.checkedAt, now);
  assert.deepEqual(repo.archivedIds, ["idle"]);
  assert.equal(gateway.dms.length, 2);
  assert.deepEqual(gateway.dms.map((m) => m.side).sort(), ["A", "B"]);
  assert.ok(gateway.dms[0].message.includes("24時間"));
  assert.equal(gateway.talks.length, 1);
  assert.ok(gateway.talks[0].includes("自動アーカイブ"));
});

test("finished / archived セッションはスキップされる", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const long_ago = now - idleTimeoutMs * 10;
  const sessions: Session[] = [
    makeSession({ id: "finished", lastActivityAt: long_ago, phase: "finished" }),
    makeSession({ id: "archived", lastActivityAt: long_ago, phase: "archived" }),
  ];
  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();
  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => sessions,
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    now: () => now,
  });

  const result = await checker.check();

  assert.deepEqual(result.archivedSessionIds, []);
  assert.deepEqual(repo.archivedIds, []);
  assert.equal(gateway.dms.length, 0);
  assert.equal(gateway.talks.length, 0);
});

test("境界条件: lastActivityAt === now - idleTimeoutMs はアーカイブ対象（<= 閾値）", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const boundary = makeSession({
    id: "boundary",
    lastActivityAt: now - idleTimeoutMs, // ちょうど閾値
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();
  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => [boundary],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    now: () => now,
  });

  const result = await checker.check();
  assert.deepEqual(result.archivedSessionIds, ["boundary"]);
});

test("片側DM未登録で sendDm が失敗してもアーカイブは成立する", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const session = makeSession({
    id: "one-side",
    lastActivityAt: now - idleTimeoutMs - 1,
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  gateway.failOnSides = ["B"];
  const repo = new StubSessionRepository();
  const errors: unknown[] = [];

  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => [session],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    now: () => now,
    onError: (err) => errors.push(err),
  });

  const result = await checker.check();
  assert.deepEqual(result.archivedSessionIds, ["one-side"]);
  assert.deepEqual(repo.archivedIds, ["one-side"]);
  // A には届き、B への送信で onError が 1 回、#talk はちゃんと出る
  assert.equal(gateway.dms.length, 1);
  assert.equal(gateway.dms[0].side, "A");
  assert.equal(gateway.talks.length, 1);
  assert.equal(errors.length, 1);
});

test("archive が失敗したセッションは archivedSessionIds に含まれず、通知もしない", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const failing = makeSession({
    id: "fail",
    lastActivityAt: now - idleTimeoutMs - 1,
    phase: "preparing",
  });
  const ok = makeSession({
    id: "ok",
    lastActivityAt: now - idleTimeoutMs - 1,
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();
  repo.failOnIds = ["fail"];
  const errors: unknown[] = [];

  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => [failing, ok],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    now: () => now,
    onError: (err) => errors.push(err),
  });

  const result = await checker.check();
  assert.deepEqual(result.archivedSessionIds, ["ok"]);
  assert.deepEqual(repo.archivedIds, ["ok"]);
  // 失敗したセッションに対する通知は出ない
  assert.equal(gateway.dms.length, 2); // ok の A/B のみ
  assert.equal(gateway.talks.length, 1);
  assert.equal(errors.length, 1);
});

test("start() は即時に1回 check + setInterval で周期チェックを登録する", async () => {
  const now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const stale = makeSession({
    id: "stale",
    lastActivityAt: now - idleTimeoutMs - 1,
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();

  const intervalCalls: { handler: () => void; ms: number }[] = [];
  let clearCalls = 0;
  const fakeId = Symbol("interval") as unknown as ReturnType<typeof setInterval>;

  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => [stale],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    checkIntervalMs: 3_600_000,
    now: () => now,
    setInterval: (handler, ms) => {
      intervalCalls.push({ handler, ms });
      return fakeId;
    },
    clearInterval: () => {
      clearCalls += 1;
    },
  });

  checker.start();
  // setInterval は 1 回だけ呼ばれる
  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].ms, 3_600_000);

  // 起動時 check を待つ（runAsync は fire-and-forget なので microtask を一周）
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(repo.archivedIds, ["stale"]);

  // 二重 start は無視される
  checker.start();
  assert.equal(intervalCalls.length, 1);

  // stop() で clearInterval が呼ばれる
  checker.stop();
  assert.equal(clearCalls, 1);

  // 二重 stop は無視
  checker.stop();
  assert.equal(clearCalls, 1);
});

test("interval tick でも check が走る（次の tick で別セッションがアーカイブされる）", async () => {
  let now = 1_000_000_000_000;
  const idleTimeoutMs = 60_000;
  const s1 = makeSession({
    id: "s1",
    lastActivityAt: now - idleTimeoutMs - 1,
    phase: "preparing",
  });
  const s2 = makeSession({
    id: "s2",
    lastActivityAt: now - 1, // まだ新しい
    phase: "preparing",
  });

  const gateway = new RecordingMessageGateway();
  const repo = new StubSessionRepository();

  const tickHandlerRef: { fn: (() => void) | null } = { fn: null };
  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () =>
      // s1 は先にアーカイブされたものは除外する想定
      repo.archivedIds.includes("s1") ? [s2] : [s1, s2],
    sessionRepository: repo,
    messageGateway: gateway,
    idleTimeoutMs,
    checkIntervalMs: 3_600_000,
    now: () => now,
    setInterval: (handler) => {
      tickHandlerRef.fn = handler;
      return Symbol("id") as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {},
  });

  checker.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(repo.archivedIds, ["s1"]);

  // 時刻を進め、s2 も閾値を超える状態にしてから tick
  now += idleTimeoutMs + 10;
  assert.ok(tickHandlerRef.fn, "tick handler が登録されている");
  tickHandlerRef.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(repo.archivedIds, ["s1", "s2"]);

  checker.stop();
});

test("listActiveSessions が throw しても onError に渡して check は落ちない", async () => {
  const errors: unknown[] = [];
  const checker = new SessionTimeoutChecker({
    listActiveSessions: async () => {
      throw new Error("DB down");
    },
    sessionRepository: new StubSessionRepository(),
    messageGateway: new RecordingMessageGateway(),
    idleTimeoutMs: 60_000,
    now: () => 0,
    onError: (err) => errors.push(err),
  });

  const result = await checker.check();
  assert.deepEqual(result.archivedSessionIds, []);
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /DB down/);
});
