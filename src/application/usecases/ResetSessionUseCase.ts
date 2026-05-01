import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";

// 依頼人の DM「リセット」「reset」で現セッションを破棄し、
// 両者に通知したうえで即座に新規セッションを始められる状態へ戻す。
//
// リセットは「全フェーズ」で効く必要がある（preparing/ready/
// debating/hearing/judging/appeal_pending/finished 全て）。SessionStateMachine.reset
// は phase 遷移の assert を行わないため、どの phase からでも呼べる。
//
// 片側の DM チャンネルしか登録されていない場合（preparing の初期段階など）、
// もう片側への DM 送信は DiscordMessageGateway が例外を投げるため、
// ここで握り潰して続行する。リセット自体は成立させる。
export interface ResetSessionInput {
  guildId: string;
}

export interface ResetSessionOutput {
  hadActiveSession: boolean;
  archivedSessionId: string | null;
  notifiedSides: ParticipantSide[];
}

const RESET_NOTICE = "🔄 セッションがリセットされた。また本音送って。";

export class ResetSessionUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly messageGateway: MessageGateway
  ) {}

  async execute(input: ResetSessionInput): Promise<ResetSessionOutput> {
    const session = await this.sessionRepository.findActiveByGuildId(
      input.guildId
    );

    if (!session) {
      return {
        hadActiveSession: false,
        archivedSessionId: null,
        notifiedSides: [],
      };
    }

    this.stateMachine.reset(session);
    await this.sessionRepository.save(session);

    const notifiedSides: ParticipantSide[] = [];
    try {
      await this.messageGateway.sendDmToA(RESET_NOTICE);
      notifiedSides.push("A");
    } catch {
      // DM チャンネル未登録側（まだ本人が DM していない側）はスキップ。
      // 相手が初めて DM してきた時に通常フローで対応する。
    }
    try {
      await this.messageGateway.sendDmToB(RESET_NOTICE);
      notifiedSides.push("B");
    } catch {
      // 同上。
    }

    return {
      hadActiveSession: true,
      archivedSessionId: session.id,
      notifiedSides,
    };
  }
}
