import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantLlmGateway } from "../ports/LlmGateway.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";

// 最終審（または上告放棄）で敗者が確定した場合に、
// その敗者だけに振り返りメッセージを DM で送る UseCase。
//   - 引き分け: 誰が「敗者」か決まっていないので送らない
//   - 判決未実施: 異常系なので送らない
//   - LLM が空文字列を返した: DM 本体が空になるので送らない
//   - LLM エラー: 握りつぶす（セッション終了フロー自体は止めない）
// 判決履歴は第一審〜最終審までの summary を順に渡して「どう転んだか」を
// 代理人側で参照できるようにする。
export class SendConsolationUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly llmGateway: ParticipantLlmGateway,
    private readonly messageGateway: MessageGateway
  ) {}

  async execute(sessionId: string): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      return;
    }
    const latestJudgment = session.rounds.at(-1)?.judgment;
    if (!latestJudgment || latestJudgment.winner === "draw") {
      return;
    }

    const loserSide: ParticipantSide =
      latestJudgment.winner === "A" ? "B" : "A";
    const loserContext =
      session.getAgentMemory(loserSide).privateBrief || "";
    const judgmentHistory = session.rounds
      .map((round) => round.judgment)
      .filter((judgment): judgment is Judgment => judgment !== null)
      .map((judgment) => judgment.summary || "");

    let consolation: string;
    try {
      consolation = await this.llmGateway.generateConsolation({
        side: loserSide,
        loserContext,
        judgmentHistory,
      });
    } catch {
      return;
    }

    const trimmed = consolation.trim();
    if (!trimmed) {
      return;
    }

    const body = `💬 お疲れ。最後にひとこと。\n\n${trimmed}`;
    if (loserSide === "A") {
      await this.messageGateway.sendDmToA(body);
    } else {
      await this.messageGateway.sendDmToB(body);
    }
  }
}
