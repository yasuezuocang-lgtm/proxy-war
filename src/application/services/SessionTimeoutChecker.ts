import type { Session } from "../../domain/entities/Session.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { SessionRepository } from "../ports/SessionRepository.js";

// セッションが SESSION_IDLE_TIMEOUT_MS（本番=24時間）無応答なら
// 自動でアーカイブし、両者の DM + #talk に通知する。
//
// 責務:
//  - 定期的に active セッション一覧をスキャン
//  - 各セッションの lastActivityAt が threshold を超えたら archive + 通知
//  - finished / archived は除外（既にアーカイブ済みや判決済みは無視）
//
// 依存は以下を narrow interface で取る（InMemory/Encrypted 実装を修正せずに済む）:
//  - listActiveSessions: 現在アクティブなセッション一覧を返す関数
//  - sessionRepository: archive のみ使う
//  - messageGateway: DM と #talk の通知
//  - idleTimeoutMs: タイムアウト判定の閾値
//  - checkIntervalMs: 定期チェック間隔（省略時 1 時間）
//  - now: テスト用の時刻差し替え
//  - setInterval/clearInterval: テスト用の時刻差し替え
//  - onError: 失敗時のロギング差し替え（デフォルトは黙って握りつぶす）

export type IntervalId = ReturnType<typeof setInterval>;

export interface SessionTimeoutCheckerDeps {
  readonly listActiveSessions: () => Promise<Session[]>;
  readonly sessionRepository: Pick<SessionRepository, "archive">;
  readonly messageGateway: MessageGateway;
  readonly idleTimeoutMs: number;
  readonly checkIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (handler: () => void, ms: number) => IntervalId;
  readonly clearInterval?: (id: IntervalId) => void;
  readonly onError?: (err: unknown) => void;
}

export interface TimeoutCheckResult {
  readonly archivedSessionIds: string[];
  readonly checkedAt: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 3_600_000; // 1 時間
const TIMEOUT_NOTICE_DM =
  "⏰ 24時間反応がなかったので、このセッションは自動でアーカイブされた。\n" +
  "また始めたくなったら、本音をDMで送って。";
const TIMEOUT_NOTICE_TALK =
  "⏰ このセッションは24時間無応答だったので自動アーカイブされた。";

export class SessionTimeoutChecker {
  private readonly listActiveSessions: () => Promise<Session[]>;
  private readonly sessionRepository: Pick<SessionRepository, "archive">;
  private readonly messageGateway: MessageGateway;
  private readonly idleTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number
  ) => IntervalId;
  private readonly clearIntervalFn: (id: IntervalId) => void;
  private readonly onError: (err: unknown) => void;
  private timer: IntervalId | null = null;

  constructor(deps: SessionTimeoutCheckerDeps) {
    if (!Number.isFinite(deps.idleTimeoutMs) || deps.idleTimeoutMs <= 0) {
      throw new Error(
        `idleTimeoutMs は正の数で指定してください（現在: ${deps.idleTimeoutMs}）`
      );
    }
    const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0) {
      throw new Error(
        `checkIntervalMs は正の数で指定してください（現在: ${checkIntervalMs}）`
      );
    }
    this.listActiveSessions = deps.listActiveSessions;
    this.sessionRepository = deps.sessionRepository;
    this.messageGateway = deps.messageGateway;
    this.idleTimeoutMs = deps.idleTimeoutMs;
    this.checkIntervalMs = checkIntervalMs;
    this.nowFn = deps.now ?? (() => Date.now());
    this.setIntervalFn =
      deps.setInterval ??
      ((handler, ms) => globalThis.setInterval(handler, ms));
    this.clearIntervalFn =
      deps.clearInterval ?? ((id) => globalThis.clearInterval(id));
    this.onError = deps.onError ?? (() => {});
  }

  // 1 回分のチェックを実行する。起動時に 1 回呼び、その後 start() の interval で呼ばれる。
  // 失敗したセッションがあっても他を止めないよう、例外は個別にキャッチして次へ進む。
  async check(): Promise<TimeoutCheckResult> {
    const checkedAt = this.nowFn();
    const threshold = checkedAt - this.idleTimeoutMs;

    let sessions: Session[];
    try {
      sessions = await this.listActiveSessions();
    } catch (err) {
      this.onError(err);
      return { archivedSessionIds: [], checkedAt };
    }

    const archivedSessionIds: string[] = [];
    for (const session of sessions) {
      if (session.phase === "finished" || session.phase === "archived") {
        continue;
      }
      if (session.lastActivityAt > threshold) {
        continue;
      }

      try {
        await this.sessionRepository.archive(session.id);
      } catch (err) {
        this.onError(err);
        continue;
      }

      await this.safelyNotify(() =>
        this.messageGateway.sendDmToA(TIMEOUT_NOTICE_DM)
      );
      await this.safelyNotify(() =>
        this.messageGateway.sendDmToB(TIMEOUT_NOTICE_DM)
      );
      await this.safelyNotify(() =>
        this.messageGateway.sendTalkMessage(TIMEOUT_NOTICE_TALK)
      );

      archivedSessionIds.push(session.id);
    }

    return { archivedSessionIds, checkedAt };
  }

  // 起動時に 1 回すぐチェックし、以後 checkIntervalMs 間隔で繰り返す。
  // 二重 start は無視（既存 timer を壊さない）。
  start(): void {
    if (this.timer !== null) return;
    this.runAsync();
    this.timer = this.setIntervalFn(
      () => this.runAsync(),
      this.checkIntervalMs
    );
  }

  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  private runAsync(): void {
    this.check().catch((err) => this.onError(err));
  }

  private async safelyNotify(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (err) {
      // 片側 DM 未登録などの理由で通知に失敗してもアーカイブ自体は成立させる。
      this.onError(err);
    }
  }
}
