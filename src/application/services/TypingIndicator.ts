import type {
  MessageGateway,
  TalkSpeaker,
} from "../ports/MessageGateway.js";

// P1-21: LLM 呼び出し中に Discord の「入力中...」を継続表示するためのヘルパ。
// Discord の typing は送ってから ~10 秒で自動消滅するので、長時間の LLM 呼び出し中は
// TYPING_REFRESH_INTERVAL_MS 間隔で再送する必要がある。
// withTyping() に async 処理を渡すと、処理の開始〜完了（成功/例外問わず）の間
// typing を流し続け、setInterval は必ず clearInterval される。

export type TypingTarget =
  | { readonly kind: "dm"; readonly side: "A" | "B" }
  | { readonly kind: "talk"; readonly speaker?: TalkSpeaker };

export type IntervalId = ReturnType<typeof setInterval>;

// setInterval / clearInterval を差し替えられるようにして、テスト時は
// FakeTimers でカチカチ刻める形にする（本番は global の setInterval を使う）。
export interface TypingIndicatorDeps {
  readonly gateway: MessageGateway;
  readonly refreshIntervalMs: number;
  readonly setInterval?: (handler: () => void, ms: number) => IntervalId;
  readonly clearInterval?: (id: IntervalId) => void;
}

export class TypingIndicator {
  private readonly gateway: MessageGateway;
  private readonly refreshIntervalMs: number;
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number
  ) => IntervalId;
  private readonly clearIntervalFn: (id: IntervalId) => void;

  constructor(deps: TypingIndicatorDeps) {
    if (deps.refreshIntervalMs <= 0) {
      throw new Error(
        `refreshIntervalMs は正の数で指定してください（現在: ${deps.refreshIntervalMs}）`
      );
    }
    this.gateway = deps.gateway;
    this.refreshIntervalMs = deps.refreshIntervalMs;
    this.setIntervalFn =
      deps.setInterval ??
      ((handler, ms) => globalThis.setInterval(handler, ms));
    this.clearIntervalFn =
      deps.clearInterval ?? ((id) => globalThis.clearInterval(id));
  }

  // async 処理を包む。開始直後に即 1 回 typing を送り、以降 refreshIntervalMs 毎に再送。
  // operation が resolve / reject どちらでも、finally で必ず clearInterval する。
  // typing 送信の失敗は握りつぶす（LLM 呼び出し本体を止めないため）。
  async withTyping<T>(
    target: TypingTarget,
    operation: () => Promise<T>
  ): Promise<T> {
    const send = (): void => {
      this.sendOnce(target).catch(() => {
        // Discord 側のレート制限やネットワーク失敗は無視。
        // typing は演出なので、本処理を止めたくない。
      });
    };

    send();
    const handle = this.setIntervalFn(send, this.refreshIntervalMs);
    try {
      return await operation();
    } finally {
      this.clearIntervalFn(handle);
    }
  }

  private async sendOnce(target: TypingTarget): Promise<void> {
    if (target.kind === "dm") {
      await this.gateway.sendTyping(target.side);
      return;
    }
    // #talk typing は optional。実装していない gateway（一部のテスト Fake）では
    // no-op としてスキップする。
    if (typeof this.gateway.sendTalkTyping === "function") {
      await this.gateway.sendTalkTyping(target.speaker);
    }
  }
}
