import test from "node:test";
import assert from "node:assert/strict";
import {
  TypingIndicator,
  type IntervalId,
} from "./TypingIndicator.js";
import type { MessageGateway, TalkSpeaker } from "../ports/MessageGateway.js";

class RecordingGateway implements MessageGateway {
  readonly dmTypings: ("A" | "B")[] = [];
  readonly talkTypings: (TalkSpeaker | undefined)[] = [];

  async sendDmToA(): Promise<void> {}
  async sendDmToB(): Promise<void> {}
  async sendTalkMessage(): Promise<void> {}
  async sendTypingToA(): Promise<void> {
    this.dmTypings.push("A");
  }
  async sendTypingToB(): Promise<void> {
    this.dmTypings.push("B");
  }
  async sendTalkTyping(speaker?: TalkSpeaker): Promise<void> {
    this.talkTypings.push(speaker);
  }
}

// #talk typing を実装していない gateway（テスト用の軽量 Fake 想定）。
class DmOnlyGateway implements MessageGateway {
  readonly dmTypings: ("A" | "B")[] = [];

  async sendDmToA(): Promise<void> {}
  async sendDmToB(): Promise<void> {}
  async sendTalkMessage(): Promise<void> {}
  async sendTypingToA(): Promise<void> {
    this.dmTypings.push("A");
  }
  async sendTypingToB(): Promise<void> {
    this.dmTypings.push("B");
  }
}

// 手動でチクタクさせる fake timer。setInterval に渡されたハンドラを
// advance(ms) で必要回数（= Math.floor(ms / interval)）だけ呼ぶ。
// withTyping 内の最初の同期 send() は setInterval とは独立なのでカウントに含めない。
function createFakeTimers() {
  const intervals = new Map<
    number,
    { handler: () => void; intervalMs: number }
  >();
  let nextId = 1;

  const setIntervalFn = (handler: () => void, ms: number): IntervalId => {
    const id = nextId++;
    intervals.set(id, { handler, intervalMs: ms });
    return id as unknown as IntervalId;
  };

  const clearIntervalFn = (id: IntervalId): void => {
    intervals.delete(id as unknown as number);
  };

  const advance = (elapsedMs: number): void => {
    for (const { handler, intervalMs } of intervals.values()) {
      const fires = Math.floor(elapsedMs / intervalMs);
      for (let i = 0; i < fires; i++) handler();
    }
  };

  const activeCount = (): number => intervals.size;

  return { setIntervalFn, clearIntervalFn, advance, activeCount };
}

test("TypingIndicator: refreshIntervalMs が 0 以下ならコンストラクタで拒否", () => {
  const gateway = new RecordingGateway();
  assert.throws(
    () =>
      new TypingIndicator({ gateway, refreshIntervalMs: 0 }),
    /refreshIntervalMs/
  );
  assert.throws(
    () =>
      new TypingIndicator({ gateway, refreshIntervalMs: -1 }),
    /refreshIntervalMs/
  );
});

test("TypingIndicator: DM typing を即時 1 回送り、interval 毎に再送する", async () => {
  const gateway = new RecordingGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  let resolveOp: (v: string) => void = () => {};
  const opPromise = indicator.withTyping(
    { kind: "dm", side: "A" },
    () =>
      new Promise<string>((resolve) => {
        resolveOp = resolve;
      })
  );

  // 開始直後: 即時送信の 1 回のみ。
  assert.equal(gateway.dmTypings.length, 1);
  assert.equal(gateway.dmTypings[0], "A");

  // 12 秒経過 → 5 秒間隔なので 2 回追加送信（計 3 回）。
  timers.advance(12000);
  assert.equal(gateway.dmTypings.length, 3);
  gateway.dmTypings.forEach((s) => assert.equal(s, "A"));

  // さらに 18 秒 → 3 回追加（計 6 回）。
  timers.advance(18000);
  assert.equal(gateway.dmTypings.length, 6);

  resolveOp("done");
  const result = await opPromise;
  assert.equal(result, "done");

  // 完了後は setInterval が解放されている。
  assert.equal(timers.activeCount(), 0);
});

test("TypingIndicator: #talk typing は speaker を付けて送る", async () => {
  const gateway = new RecordingGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  await indicator.withTyping(
    { kind: "talk", speaker: "B" },
    async () => {
      timers.advance(10000); // 5 秒刻みで 2 回
    }
  );

  // 即時 1 + 2 = 3 回、全て speaker="B"。
  assert.equal(gateway.talkTypings.length, 3);
  gateway.talkTypings.forEach((s) => assert.equal(s, "B"));
  assert.equal(gateway.dmTypings.length, 0);
  assert.equal(timers.activeCount(), 0);
});

test("TypingIndicator: 例外が出ても interval は clear される", async () => {
  const gateway = new RecordingGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  await assert.rejects(
    indicator.withTyping({ kind: "dm", side: "A" }, async () => {
      timers.advance(6000); // 1 回刻んでから throw
      throw new Error("LLM 呼び出し失敗");
    }),
    /LLM 呼び出し失敗/
  );

  assert.equal(timers.activeCount(), 0, "clearInterval が呼ばれている");
  // 即時 1 + 6000ms 内に 1 回 = 2 回送信されている
  assert.equal(gateway.dmTypings.length, 2);
});

test("TypingIndicator: sendTalkTyping 未実装 gateway でも落ちない", async () => {
  const gateway = new DmOnlyGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  await indicator.withTyping({ kind: "talk", speaker: "A" }, async () => {
    timers.advance(10000);
  });

  // DM 側は触っていない、#talk は no-op 扱いでエラーなし。
  assert.equal(gateway.dmTypings.length, 0);
  assert.equal(timers.activeCount(), 0);
});

test("TypingIndicator: sendTyping が throw しても operation は継続する", async () => {
  class ThrowingGateway implements MessageGateway {
    sendCount = 0;
    async sendDmToA(): Promise<void> {}
    async sendDmToB(): Promise<void> {}
    async sendTalkMessage(): Promise<void> {}
    async sendTypingToA(): Promise<void> {
      this.sendCount++;
      throw new Error("rate limit");
    }
    async sendTypingToB(): Promise<void> {
      this.sendCount++;
      throw new Error("rate limit");
    }
  }

  const gateway = new ThrowingGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  const result = await indicator.withTyping(
    { kind: "dm", side: "A" },
    async () => {
      timers.advance(10000);
      return "operation-ok";
    }
  );

  assert.equal(result, "operation-ok");
  assert.ok(gateway.sendCount >= 2);
  assert.equal(timers.activeCount(), 0);
});

test("TypingIndicator: 送信回数は経過時間に比例する", async () => {
  const gateway = new RecordingGateway();
  const timers = createFakeTimers();
  const indicator = new TypingIndicator({
    gateway,
    refreshIntervalMs: 5000,
    setInterval: timers.setIntervalFn,
    clearInterval: timers.clearIntervalFn,
  });

  await indicator.withTyping({ kind: "dm", side: "A" }, async () => {
    timers.advance(25000);
  });

  // 即時1 + 25s/5s=5 = 6回
  assert.equal(gateway.dmTypings.length, 6);

  await indicator.withTyping({ kind: "dm", side: "B" }, async () => {
    timers.advance(5000);
  });

  // 追加: 即時1 + 5s/5s=1 = 2回 → 合計 8
  assert.equal(gateway.dmTypings.length, 8);
  assert.equal(gateway.dmTypings.filter((s) => s === "B").length, 2);
});
