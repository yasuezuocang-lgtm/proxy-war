import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { SessionPhase } from "../../domain/value-objects/SessionPhase.js";

// SPEC §6.9 / P1-19: Bot 起動時のセッション復元。
// EncryptedSessionRepository から前回の active セッションを探し、
// 現在の phase に応じて「どう再開するか」を決める司会前段の処理。
//
// phase 別の方針:
//   preparing / ready : そのまま保持（DM を待てば通常フローに戻る）
//   finished / archived : そのまま保持（何もしない）
//   debating / judging / hearing / appeal_pending :
//     ランタイム内部の timer / orchestrator 実行状態が消えており、
//     安全に途中再開する手段がないため archive 扱いにして
//     #talk で両者へ「中断扱いにした、やり直してほしい」と告知する。
//
// この方針はシンプルだが保守的。後で「turn 再送」「appeal タイマー再張」など
// 段階的に resumable な phase を増やしていける設計にしてある（RestoreResult で
// 呼び出し側が次アクションを選べる）。
export type RestoreResult =
  | { type: "none" }
  | { type: "kept"; sessionId: string; phase: SessionPhase }
  | {
      type: "archived";
      sessionId: string;
      interruptedPhase: SessionPhase;
    };

const RESUMABLE_PHASES: readonly SessionPhase[] = [
  "preparing",
  "ready",
  "finished",
  "archived",
];

export class SessionRestorer {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly messageGateway: MessageGateway
  ) {}

  async restore(guildId: string): Promise<RestoreResult> {
    const session = await this.sessionRepository.findActiveByGuildId(guildId);
    if (!session) {
      return { type: "none" };
    }

    if (RESUMABLE_PHASES.includes(session.phase)) {
      return { type: "kept", sessionId: session.id, phase: session.phase };
    }

    const interruptedPhase = session.phase;
    await this.sessionRepository.archive(session.id);
    await this.messageGateway.sendTalkMessage(
      "🔄 Botが再起動した。前回のセッションは途中だったので中断扱いにした。\n" +
        "続けるならもう一度DMで本音を送って。"
    );
    return {
      type: "archived",
      sessionId: session.id,
      interruptedPhase,
    };
  }
}
