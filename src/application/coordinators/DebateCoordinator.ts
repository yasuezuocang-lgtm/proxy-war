import { loadAppConfig } from "../../config.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import type { ParticipantLlmGateway } from "../ports/LlmGateway.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantResponseGateway } from "../ports/ParticipantResponseGateway.js";
import type { DebateAgents } from "../ports/ParticipantAgent.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Session } from "../../domain/entities/Session.js";
import { StartDebateUseCase } from "../usecases/StartDebateUseCase.js";
import { ProcessAgentTurnUseCase } from "../usecases/ProcessAgentTurnUseCase.js";
import { SubmitHearingAnswerUseCase } from "../usecases/SubmitHearingAnswerUseCase.js";
import {
  JudgeRoundUseCase,
  type JudgePort,
} from "../usecases/JudgeRoundUseCase.js";
import { RunAppealCycleUseCase } from "../usecases/RunAppealCycleUseCase.js";
import { SendConsolationUseCase } from "../usecases/SendConsolationUseCase.js";
import { IsolationPolicy } from "../../domain/policies/IsolationPolicy.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 司会（DebateCoordinator）。
// 責務はターン順管理・ラウンド進行・判定起動・上告サイクル調整に絞る。
// 発言の中身を作るのは各 ParticipantAgent 側、各サブ責務は UseCase に委譲する。
//   - StartDebateUseCase            : 開幕アナウンス + debating 遷移
//   - ProcessAgentTurnUseCase       : 1ターン分の発話 or HEARING 発火判定
//   - SubmitHearingAnswerUseCase    : ヒアリングサイクル全体
//   - JudgeRoundUseCase             : 判定 + スコアボード公開
//   - RunAppealCycleUseCase         : 上告サイクル（提案 + DM + 受理）
//   - SendConsolationUseCase        : 敗者へのねぎらいDM
// この司会自身は LLM Gateway を直接呼ばない（grep で確認できる）。
export class DebateCoordinator {
  private readonly startDebate: StartDebateUseCase;
  private readonly processAgentTurn: ProcessAgentTurnUseCase;
  private readonly submitHearingAnswer: SubmitHearingAnswerUseCase;
  private readonly judgeRound: JudgeRoundUseCase;
  private readonly runAppealCycle: RunAppealCycleUseCase;
  private readonly sendConsolation: SendConsolationUseCase;

  constructor(
    private readonly sessionRepository: SessionRepository,
    stateMachine: SessionStateMachine,
    private readonly participantAgents: DebateAgents,
    // 代理人が使う LLM Gateway は ParticipantLlmGateway のみ。
    // 判定は JudgePort（infrastructure/agents/JudgeAgent 実装）から受ける。
    participantLlmGateway: ParticipantLlmGateway,
    judgeAgent: JudgePort,
    private readonly messageGateway: MessageGateway,
    participantResponseGateway: ParticipantResponseGateway,
    private readonly turnDelayMs = loadAppConfig().debate.turnDelayMs,
    maxHearingFollowups = loadAppConfig().hearing.maxHearingFollowups
  ) {
    this.startDebate = new StartDebateUseCase(
      sessionRepository,
      stateMachine,
      messageGateway
    );
    this.processAgentTurn = new ProcessAgentTurnUseCase(
      sessionRepository,
      messageGateway,
      participantAgents
    );
    this.submitHearingAnswer = new SubmitHearingAnswerUseCase(
      sessionRepository,
      stateMachine,
      messageGateway,
      participantResponseGateway,
      participantAgents,
      maxHearingFollowups
    );
    this.judgeRound = new JudgeRoundUseCase(
      sessionRepository,
      stateMachine,
      judgeAgent,
      messageGateway
    );
    this.runAppealCycle = new RunAppealCycleUseCase(
      sessionRepository,
      stateMachine,
      messageGateway,
      participantResponseGateway,
      participantAgents
    );
    this.sendConsolation = new SendConsolationUseCase(
      sessionRepository,
      participantLlmGateway,
      messageGateway
    );

    // 司会クラス自身が代理人記憶（agentMemoryA/B / privateBrief / privateGoal）を
    // 直接フィールドとして抱えていないことをコンストラクタ時に検証する。
    IsolationPolicy.assertNoOpponentMemoryRef(this);
  }

  async run(sessionId: string): Promise<void> {
    await this.startDebate.execute(sessionId);
    await this.runDebateLoop(sessionId);
    await this.judgeRound.execute(sessionId);

    // 上告ループ: appeal_pending のたびに敗者へ DM で問いかけ、
    // 異議が来たら次審を作って再審AIに再評価させる。
    // タイムアウトまたは異議なし、もしくは最終審まで到達したら session が finished になる。
    while ((await this.requireSession(sessionId)).phase === "appeal_pending") {
      const proceeded = await this.runAppealCycle.execute(sessionId);
      if (!proceeded) {
        break;
      }
      await this.judgeRound.execute(sessionId);
    }

    await this.finalizeSession(sessionId);
  }

  private async runDebateLoop(sessionId: string): Promise<void> {
    let currentSide: ParticipantSide = "A";
    let hearingCount = { A: 0, B: 0 };
    let completedTurns = 0;

    const session = await this.requireSession(sessionId);
    const maxTurns = session.policy.maxTurns;

    while (completedTurns < maxTurns) {
      await sleep(this.turnDelayMs);
      const roundSession = await this.requireSession(sessionId);

      const result = await this.processAgentTurn.execute({
        sessionId,
        side: currentSide,
        turnIndex: completedTurns,
        hearingsUsed: hearingCount[currentSide],
        maxHearings: roundSession.policy.maxHearingsPerSide,
      });

      if (result.type === "hearing") {
        hearingCount = await this.submitHearingAnswer.execute({
          sessionId,
          side: currentSide,
          hearingCount,
          question: result.question,
          reason: result.reason,
        });
        continue;
      }

      completedTurns += 1;
      currentSide = currentSide === "A" ? "B" : "A";
    }
  }

  private async finalizeSession(sessionId: string): Promise<void> {
    await this.sendConsolation.execute(sessionId);

    await this.messageGateway.sendTalkMessage(
      "━━━\n終了。もう1回やるならBotに「リセット」ってDMして。\n━━━"
    );

    this.participantAgents.A.resetSession(sessionId);
    this.participantAgents.B.resetSession(sessionId);
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }
    return session;
  }
}
