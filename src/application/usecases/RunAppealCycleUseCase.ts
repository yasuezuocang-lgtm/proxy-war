import type { SessionRepository } from "../ports/SessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantResponseGateway } from "../ports/ParticipantResponseGateway.js";
import type { DebateAgents, PublicTurn } from "../ports/ParticipantAgent.js";
import { asOwnBrief } from "../ports/ParticipantAgent.js";
import { SessionStateMachine } from "../services/SessionStateMachine.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { Session } from "../../domain/entities/Session.js";
import {
  COURT_LABELS,
  type CourtLevel,
} from "../../domain/value-objects/CourtLevel.js";

// 上告サイクル全体を担う UseCase。
// 司会から appeal_pending 中に呼ばれ、敗者（or 引き分け時の双方）に
// DMで「異議ある？」と問い合わせる。
//   - 異議あり: 次審ラウンドを作って true を返す（司会は次の judgeRound を呼ぶ）
//   - タイムアウト/異議なし: session を finished にして false を返す
// 各代理人が自側 brief だけを根拠に異議材料を生成し、案内DMに添える。
export class RunAppealCycleUseCase {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly messageGateway: MessageGateway,
    private readonly participantResponseGateway: ParticipantResponseGateway,
    private readonly participantAgents: DebateAgents
  ) {}

  async execute(sessionId: string): Promise<boolean> {
    const session = await this.requireSession(sessionId);
    const eligibleSides = [...session.appealableSides];
    if (eligibleSides.length === 0) {
      return false;
    }

    // リスナー登録は #talk や DM の案内送信よりも先に行う（順序を変えると取りこぼす）。
    // 案内送信は Discord への数往復に数秒かかる。その間に
    // ユーザーが「スコアボードを見てすぐ異議を打つ」と DM が先に届き、
    // resolver 未登録で取りこぼす。先に Promise を作れば executor が
    // 同期で resolver を registry に登録するのでレースが閉じる。
    const appealPromise = this.waitForAppeal(
      eligibleSides,
      session.policy.appealTimeoutMs
    );

    const nextLevel = this.peekNextCourtLevel(session);
    const nextCourtLabel = nextLevel ? COURT_LABELS[nextLevel] : "上告審";
    const timeoutSec = Math.floor(session.policy.appealTimeoutMs / 1000);
    const eligibleLabel = eligibleSides.join("・");

    await this.messageGateway.sendTalkMessage(
      `📣 ${eligibleLabel}側に異議申し立ての権利あり。` +
        `${timeoutSec}秒以内にDMで理由を送れば${nextCourtLabel}へ進む。`
    );

    // 各代理人が、自側の brief だけを根拠に異議材料を並列生成する。
    // A代理はAの事情しか見ない・B代理はBの事情しか見ない（型で強制）。
    const suggestions = await this.generateAppealSuggestions(
      session,
      eligibleSides,
      nextLevel
    );

    for (const side of eligibleSides) {
      const suggestion = suggestions[side];
      const suggestionBlock = suggestion
        ? `\n\n【${side}代理人からの提案 — 筋の通った異議材料】\n${suggestion}\n\n（あくまで提案。自分の言葉で書いていい。違う切り口でもいい）`
        : "";
      const body =
        `⚖️ 判定出た。納得いかないなら異議をDMで送って。\n` +
        `理由を具体的に書くほど${nextCourtLabel}で覆せる可能性が上がる。\n` +
        `${timeoutSec}秒以内に送らなければこのまま確定する。` +
        suggestionBlock;
      if (side === "A") {
        await this.messageGateway.sendDmToA(body);
      } else {
        await this.messageGateway.sendDmToB(body);
      }
    }

    const appealed = await appealPromise;

    const latestSession = await this.requireSession(sessionId);

    if (!appealed || !appealed.response.trim()) {
      // AppealExpired イベント発火。
      // タイマー（session.policy.appealTimeoutMs = APPEAL_WINDOW_MS）経過で
      // appeal_pending → finished に遷移し、イベントを観測側へ返す。
      // 返り値は現状ログのみだが、将来の永続化・通知リスナーが購読できる起点にする。
      const appealExpiredEvent = this.stateMachine.expireAppeal(latestSession);
      await this.sessionRepository.save(latestSession);
      await this.messageGateway.sendTalkMessage(
        `⏳ 異議なし。判定が確定した。（${COURT_LABELS[appealExpiredEvent.closedAtCourtLevel]}で終了）`
      );
      return false;
    }

    const appeal: Appeal = {
      appellantSide: appealed.side,
      content: appealed.response.trim(),
      createdAt: Date.now(),
    };

    this.stateMachine.acceptAppeal(latestSession, appeal);
    await this.sessionRepository.save(latestSession);

    if (appealed.side === "A") {
      await this.messageGateway.sendDmToA("📨 異議受理。再審に回す。");
    } else {
      await this.messageGateway.sendDmToB("📨 異議受理。再審に回す。");
    }
    await this.messageGateway.sendTalkMessage(
      `⚖️ ${appealed.side}側から異議申し立て。${nextCourtLabel}へ進む。`
    );

    return true;
  }

  // 各側の代理人に自側 brief だけを渡して異議材料を生成させる。
  // 提案生成の失敗は DM 送信を止めない（空文字列を返して DM ではセクションごと省略）。
  private async generateAppealSuggestions(
    session: Session,
    sides: ParticipantSide[],
    nextLevel: CourtLevel | null
  ): Promise<Record<ParticipantSide, string>> {
    const result: Record<ParticipantSide, string> = { A: "", B: "" };
    if (!nextLevel) {
      return result;
    }

    const judgment = session.getCurrentRound().judgment;
    if (!judgment) {
      return result;
    }

    // 対話ログは第一審（district）のものだけを使う。
    // 上告審には対話はない（前審資料と異議のみで再評価する仕様）。
    const districtRound = session.rounds[0];
    const dialogue: PublicTurn[] = districtRound.turns.map((turn) => ({
      speaker: turn.speakerSide,
      message: turn.message,
    }));

    await Promise.all(
      sides.map(async (side) => {
        result[side] = await this.suggestAppealForSide(
          session,
          side,
          judgment,
          dialogue,
          nextLevel
        );
      })
    );

    return result;
  }

  private suggestAppealForSide(
    session: Session,
    side: ParticipantSide,
    judgment: Judgment,
    dialogue: PublicTurn[],
    nextLevel: CourtLevel
  ): Promise<string> {
    const memory = session.getAgentMemory(side);
    const briefText = memory.privateBrief || "";
    const goal = memory.publicGoal;

    if (side === "A") {
      return this.participantAgents.A.suggestAppealPoints({
        sessionId: session.id,
        brief: asOwnBrief("A", briefText),
        goal,
        dialogue,
        judgment,
        nextCourtLevel: nextLevel,
      });
    }
    return this.participantAgents.B.suggestAppealPoints({
      sessionId: session.id,
      brief: asOwnBrief("B", briefText),
      goal,
      dialogue,
      judgment,
      nextCourtLevel: nextLevel,
    });
  }

  private async waitForAppeal(
    sides: ParticipantSide[],
    timeoutMs: number
  ): Promise<{ side: ParticipantSide; response: string } | null> {
    if (sides.length === 1) {
      const response = await this.participantResponseGateway.waitForResponse(
        sides[0],
        timeoutMs
      );
      return response === null ? null : { side: sides[0], response };
    }

    return this.participantResponseGateway.waitForAnyResponse(sides, timeoutMs);
  }

  private peekNextCourtLevel(session: Session): CourtLevel | null {
    const current = session.rounds.at(-1)?.courtLevel;
    if (current === "district") return "high";
    if (current === "high") return "supreme";
    return null;
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対象セッションが見つかりません。");
    }
    return session;
  }
}
