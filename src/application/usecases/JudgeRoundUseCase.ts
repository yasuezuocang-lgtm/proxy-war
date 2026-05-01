import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Session } from "../../domain/entities/Session.js";
import {
  COURT_LABELS,
  type CourtLevel,
} from "../../domain/value-objects/CourtLevel.js";
import type { JudgeRoundInput } from "../ports/LlmGateway.js";

// migration-plan §3 Step 6 / §6 二重実装解消:
// JudgeRoundUseCase は LLM Gateway 経由ではなく JudgeAgent.judgeRound を直接呼ぶ。
// クラス本体は infrastructure/agents/JudgeAgent.ts。
// アプリ層では JudgeAgent への直接依存を避けるため、judgeRound だけを切り出した
// 軽量 port を介して受け取る。
export interface JudgePort {
  judgeRound(input: JudgeRoundInput): Promise<Judgment>;
}

// 現在のラウンドを判定フェーズへ移し、審判 AI に評価させて
// 結果を #talk へ公開する UseCase。
//   - 第一審 (district): 対話全文を根拠に判定
//   - 上告審 (high/supreme): 第一審の対話 + 過去判定 + 最新異議を根拠に再評価
// 判定後は SessionStateMachine.completeJudging が appeal_pending or finished
// に遷移させる。finished に直行した場合は「これ以上の上告はできない」を告知。
export class JudgeRoundUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly judgeAgent: JudgePort,
    private readonly messageGateway: MessageGateway
  ) {}

  async execute(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const currentRound = session.getCurrentRound();

    if (currentRound.courtLevel === "district") {
      this.stateMachine.finishRound(session);
      await this.sessionRepository.save(session);
      await this.messageGateway.sendTalkMessage(
        `━━━\n対話終了（${currentRound.turns.length}ターン）\n━━━`
      );
    }

    const courtLabel = COURT_LABELS[currentRound.courtLevel];
    await this.messageGateway.sendTalkMessage(
      `⚖️ **${courtLabel} — 審判AIが判定中...**`
    );

    const districtRound = session.rounds[0];
    const judgment = await this.judgeAgent.judgeRound({
      courtLevel: currentRound.courtLevel,
      contextA: session.agentMemoryA.privateBrief || "",
      contextB: session.agentMemoryB.privateBrief || "",
      goalA: session.agentMemoryA.publicGoal,
      goalB: session.agentMemoryB.publicGoal,
      dialogue: districtRound.turns.map((turn) => ({
        speaker: turn.speakerSide,
        message: turn.message,
      })),
      previousJudgments: session.rounds
        .slice(0, -1)
        .map((round) => round.judgment)
        .filter((judgment): judgment is Judgment => judgment !== null),
      appeal: currentRound.appeal,
    });

    this.stateMachine.completeJudging(session, judgment);
    await this.sessionRepository.save(session);

    await this.publishJudgment(judgment, currentRound.courtLevel);

    // 上告枠を使い切って finished に直行した場合は、明示的に
    // 「これ以上の上告はできない」を告知する。何も書かないと
    // ユーザーは「また異議出せるのか？」で立ち止まる。
    if (session.phase === "finished") {
      await this.announceAppealExhausted(session, currentRound.courtLevel);
    }
  }

  private async announceAppealExhausted(
    session: Session,
    closedAtLevel: CourtLevel
  ): Promise<void> {
    if (closedAtLevel === "supreme") {
      await this.messageGateway.sendTalkMessage(
        "🔒 最終審で決着。これ以上の上告はできない。"
      );
      return;
    }

    // maxAppeals を 0 以下に設定した運用で district 直後に finished になるケース。
    // 最高裁まで行ってないので表現を分ける。
    if (session.policy.maxAppeals <= 0) {
      return;
    }

    await this.messageGateway.sendTalkMessage(
      `🔒 上告枠（${session.policy.maxAppeals}回）を使い切った。判定確定。`
    );
  }

  private async publishJudgment(
    judgment: Judgment,
    courtLevel: CourtLevel
  ): Promise<void> {
    const courtLabel = COURT_LABELS[courtLevel];
    const scoreBoard = this.buildScoreboard(judgment, courtLabel);
    await this.messageGateway.sendTalkMessage(scoreBoard);

    const winnerText =
      judgment.winner === "draw"
        ? "🤝 **引き分け**"
        : `🏆 **${courtLabel}の勝者: ${judgment.winner}側**`;
    await this.messageGateway.sendTalkMessage(
      this.truncateForDiscord(`${winnerText}\n\n${judgment.summary || ""}`)
    );

    if (judgment.zopa) {
      await this.messageGateway.sendTalkMessage(
        this.truncateForDiscord(`🤝 **落とし所:**\n${judgment.zopa}`)
      );
    }

    if (judgment.wisdom) {
      await this.messageGateway.sendTalkMessage(
        this.truncateForDiscord(`🧠 **Wisdom:**\n${judgment.wisdom}`)
      );
    }
  }

  // LLM が崩れた JSON を返しても落ちないスコアボード組み立て。
  // - scoreA/scoreB を数値へ正規化
  // - reason / criterion.name を長さで切り詰め
  // - 合計も数値化
  // - 全体が Discord の 2000 文字上限を超えないようにする
  private buildScoreboard(judgment: Judgment, courtLabel: string): string {
    const MAX_REASON_LENGTH = 160;
    const MAX_NAME_LENGTH = 18;
    const lines: string[] = [];

    lines.push("```");
    lines.push(`📊 ${courtLabel} スコアボード`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const criteria = Array.isArray(judgment.criteria) ? judgment.criteria : [];
    for (const rawCriterion of criteria) {
      const name = this.truncate(
        String(rawCriterion?.name ?? "項目"),
        MAX_NAME_LENGTH
      );
      const scoreA = this.coerceScore(rawCriterion?.scoreA);
      const scoreB = this.coerceScore(rawCriterion?.scoreB);
      const reason = this.truncate(
        String(rawCriterion?.reason ?? ""),
        MAX_REASON_LENGTH
      );
      lines.push(
        `${name.padEnd(MAX_NAME_LENGTH)} A: ${scoreA}/5  B: ${scoreB}/5`
      );
      if (reason) {
        lines.push(`  → ${reason}`);
      }
    }

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push(
      `合計         A: ${this.coerceTotal(judgment.totalA)}/25  B: ${this.coerceTotal(judgment.totalB)}/25`
    );
    lines.push("```");

    return this.truncateForDiscord(lines.join("\n"));
  }

  private coerceScore(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(5, Math.round(n)));
  }

  private coerceTotal(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(25, Math.round(n)));
  }

  private truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  }

  // Discord 送信上限（2000）を安全マージン付きで守る。
  // publishJudgment 途中で API エラーで落ちると appeal_pending に進めなくなるため。
  private truncateForDiscord(text: string): string {
    const MAX = 1900;
    if (text.length <= MAX) return text;
    return `${text.slice(0, MAX - 1)}…`;
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }
    return session;
  }
}
