import { DomainError } from "../../domain/errors/DomainError.js";
import type { Session } from "../../domain/entities/Session.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { BriefComposer } from "../services/BriefComposer.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";

const MAX_CONFIRMATION_REVISIONS = 5;
const ASSISTANT_TRANSCRIPT_LINE =
  /^(AI|アプリ|assistant|Assistant|Bot|SYSTEM|System)\b/;
const TRANSCRIPT_TIME_LINE = /^[—-]\s*\d{1,2}:\d{2}$/;
const GENERATED_REPLY_LINE =
  /^(これで戦う。|相手は誰？|申し訳ありませんが、私は実際の依頼人ではなく)/;
const CORRECTION_PREFIX = /^(修正|追加|訂正|違う|補足)[:：]\s*/i;
const NORMALIZE_SUMMARY_PATTERN = /[。\s「」『』、,.!?！？]/g;

export interface ConfirmBriefInput {
  sessionId: string;
  side: ParticipantSide;
  message: string;
}

export interface ConfirmBriefOutput {
  session: Session;
  reply: string;
  confirmed: boolean;
  movedToGoalSetting: boolean;
}

export class ConfirmBriefUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly briefComposer: BriefComposer
  ) {}

  async execute(input: ConfirmBriefInput): Promise<ConfirmBriefOutput> {
    const session = await this.sessionRepository.findById(input.sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }

    const participant = session.getParticipant(input.side);
    const normalized = input.message.trim().toLowerCase();

    if (normalized === "はい" || normalized === "yes" || normalized === "ok") {
      this.stateMachine.moveToGoalSetting(session, input.side);
      await this.sessionRepository.save(session);
      return {
        session,
        reply:
          "⚔️ 喧嘩モードで行く。\n勝ち取りたいゴールあれば「ゴール:○○」で。なければ「なし」で。",
        confirmed: true,
        movedToGoalSetting: true,
      };
    }

    const extractedCorrection = this.extractCorrection(input.message);
    if (!extractedCorrection) {
      return {
        session,
        reply:
          "修正したい点だけ送って。AIの返答や会話ログは混ぜないで。\n例: 修正: 相手は動物園じゃなくて行政",
        confirmed: false,
        movedToGoalSetting: false,
      };
    }
    const correction = extractedCorrection;

    participant.brief.rawInputs.push(correction);

    if (participant.followUpCount < MAX_CONFIRMATION_REVISIONS) {
      participant.followUpCount++;

      if (!participant.brief.structuredContext) {
        throw new DomainError("確認対象のブリーフが存在しません。");
      }

      const brief = await this.briefComposer.composeFromRawInputs(
        participant.brief.rawInputs
      );

      participant.brief.structuredContext = brief.structuredContext;
      const summary = this.ensureCorrectionReflected(brief.summary, correction);
      participant.brief.summary = summary;
      await this.sessionRepository.save(session);

      return {
        session,
        reply: `${summary}\n\nこれで戦う。「はい」で確定、違うとこあれば送って`,
        confirmed: false,
        movedToGoalSetting: false,
      };
    }

    this.stateMachine.moveToGoalSetting(session, input.side);
    await this.sessionRepository.save(session);

    return {
      session,
      reply:
        "修正回数の上限に達した。この内容をベースに進める。\n勝ち取りたいゴールあれば「ゴール:○○」で。なければ「なし」で。",
      confirmed: true,
      movedToGoalSetting: true,
    };
  }

  private extractCorrection(message: string): string | null {
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const cleanedLines: string[] = [];
    for (const line of lines) {
      if (
        ASSISTANT_TRANSCRIPT_LINE.test(line) ||
        TRANSCRIPT_TIME_LINE.test(line) ||
        GENERATED_REPLY_LINE.test(line)
      ) {
        break;
      }

      if (line.startsWith(">")) {
        continue;
      }

      cleanedLines.push(line.replace(CORRECTION_PREFIX, ""));
    }

    const cleaned = cleanedLines.join("\n").trim();
    if (cleaned.length === 0) {
      return null;
    }

    return cleaned;
  }

  private ensureCorrectionReflected(summary: string, correction: string): string {
    if (this.isCorrectionReflected(summary, correction)) {
      return summary;
    }

    return `最新の修正では「${correction}」が正しい。\n\n${summary}`;
  }

  private isCorrectionReflected(summary: string, correction: string): boolean {
    return this.includesNormalized(summary, correction);
  }

  private includesNormalized(text: string, search: string): boolean {
    const normalize = (value: string) =>
      value.replace(NORMALIZE_SUMMARY_PATTERN, "");

    return normalize(text).includes(normalize(search));
  }
}
