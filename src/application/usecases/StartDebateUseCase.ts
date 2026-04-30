import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { DomainError } from "../../domain/errors/DomainError.js";

// 対話開始ユースケース。
// ready 状態のセッションを district ラウンドで debating に遷移させ、
// 開幕アナウンスを #talk へ流す。司会（DebateCoordinator）から呼ばれる。
export class StartDebateUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly messageGateway: MessageGateway
  ) {}

  async execute(sessionId: string): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対話対象のセッションが見つかりません。");
    }

    this.stateMachine.startDebate(session, "district");
    await this.sessionRepository.save(session);

    const goalA = session.agentMemoryA.publicGoal || "なし";
    const goalB = session.agentMemoryB.publicGoal || "なし";
    await this.messageGateway.sendTalkMessage(
      `━━━\n⚔️ 喧嘩モード 開始\n🎯 A: ${goalA}\n🎯 B: ${goalB}\n━━━`
    );
  }
}
