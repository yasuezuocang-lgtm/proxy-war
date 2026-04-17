import type { SessionRepository } from "../ports/SessionRepository.js";
import type { RefereeLlmGateway } from "../ports/LlmGateway.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantResponseGateway } from "../ports/ParticipantResponseGateway.js";
import type {
  AgentTurnResult,
  ParticipantAgent,
  ParticipantAgents,
  PublicTurn,
} from "../ports/ParticipantAgent.js";
import { asOwnBrief } from "../ports/ParticipantAgent.js";
import { SessionStateMachine } from "./SessionStateMachine.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { Appeal } from "../../domain/entities/Appeal.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { Session } from "../../domain/entities/Session.js";
import { COURT_LABELS, type CourtLevel } from "../../domain/value-objects/CourtLevel.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DebateOrchestrator {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly participantAgents: ParticipantAgents,
    private readonly refereeGateway: RefereeLlmGateway,
    private readonly messageGateway: MessageGateway,
    private readonly participantResponseGateway: ParticipantResponseGateway,
    private readonly turnDelayMs = 3000
  ) {}

  async run(sessionId: string): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new DomainError("対話対象のセッションが見つかりません。");
    }

    this.stateMachine.startDebate(session, "district");
    await this.sessionRepository.save(session);
    await this.sendDebateOpening(session);

    await this.runDebateLoop(sessionId);
    await this.judgeCurrentRound(sessionId);

    // 上告ループ: appeal_pending のたびに敗者へ DM で問いかけ、
    // 異議が来たら次審を作って再審AIに再評価させる。
    // タイムアウトまたは異議なし、もしくは最終審まで到達したら session が finished になる。
    while ((await this.requireSession(sessionId)).phase === "appeal_pending") {
      const proceeded = await this.handleAppealCycle(sessionId);
      if (!proceeded) {
        break;
      }
      await this.judgeCurrentRound(sessionId);
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
      const participant = roundSession.getParticipant(currentSide);
      const conversation: PublicTurn[] = roundSession
        .getCurrentRound()
        .turns.map((turn) => ({
          speaker: turn.speakerSide,
          message: turn.message,
        }));

      const result = await this.callAgentForSide(currentSide, {
        sessionId,
        briefText: participant.brief.structuredContext || "",
        goal: participant.brief.goal,
        conversation,
        turnIndex: completedTurns,
      });

      if (
        result.type === "hearing" &&
        hearingCount[currentSide] < roundSession.policy.maxHearingsPerSide
      ) {
        hearingCount = await this.handleHearing(
          sessionId,
          currentSide,
          hearingCount,
          result.question
        );
        continue;
      }

      const message =
        result.type === "message"
          ? result.message
          : "今の反論材料だと弱い。依頼人の追加情報が必要だ。";
      await this.appendTurn(sessionId, currentSide, message);
      await this.messageGateway.sendTalkMessage(message, currentSide);
      completedTurns += 1;

      currentSide = currentSide === "A" ? "B" : "A";
    }
  }

  // 型レベルで片側の brief だけを渡せる入口。side の値によって
  // 選ばれる agent の型パラメータ S が揃うため、誤って反対側の brief
  // を混ぜるコードはコンパイルが通らない。
  private callAgentForSide(
    side: ParticipantSide,
    params: {
      sessionId: string;
      briefText: string;
      goal: string | null;
      conversation: PublicTurn[];
      turnIndex: number;
    }
  ): Promise<AgentTurnResult> {
    if (side === "A") {
      return this.callAgent("A", this.participantAgents.A, params);
    }
    return this.callAgent("B", this.participantAgents.B, params);
  }

  private callAgent<Side extends ParticipantSide>(
    side: Side,
    agent: ParticipantAgent<Side>,
    params: {
      sessionId: string;
      briefText: string;
      goal: string | null;
      conversation: PublicTurn[];
      turnIndex: number;
    }
  ): Promise<AgentTurnResult> {
    return agent.generateTurn({
      sessionId: params.sessionId,
      brief: asOwnBrief(side, params.briefText),
      goal: params.goal,
      conversation: params.conversation,
      turnIndex: params.turnIndex,
    });
  }

  private sendDebateOpening(session: Session): Promise<void> {
    const goalA = session.getParticipant("A").brief.goal || "なし";
    const goalB = session.getParticipant("B").brief.goal || "なし";
    return this.messageGateway.sendTalkMessage(
      `━━━\n⚔️ 喧嘩モード 開始\n🎯 A: ${goalA}\n🎯 B: ${goalB}\n━━━`
    );
  }

  private async handleHearing(
    sessionId: string,
    side: ParticipantSide,
    hearingCount: { A: number; B: number },
    question: string
  ): Promise<{ A: number; B: number }> {
    const session = await this.requireSession(sessionId);
    const request: HearingRequest = {
      requestedBy: side,
      targetSide: side,
      question,
      context: session.getCurrentRound().turns.at(-1)?.message || "",
      createdAt: Date.now(),
      answeredAt: null,
      answer: null,
    };

    this.stateMachine.requestHearing(session, request);
    await this.sessionRepository.save(session);

    await this.messageGateway.sendTalkMessage(
      `⏸️ ヒアリングタイム — ${side}側の依頼人に確認中...`
    );
    await this.messageGateway.sendDm(
      side,
      `⏸️ 対話中に確認したいことが出た。\n\n${question}\n\n返信して。終わったら対話再開する。`
    );

    const answer = await this.participantResponseGateway.waitForResponse(
      side,
      session.policy.hearingTimeoutMs
    );

    if (answer) {
      await this.updateParticipantBrief(sessionId, side, answer);
      await this.messageGateway.sendTalkMessage("▶️ ヒアリング完了 — 対話再開");
    } else {
      await this.messageGateway.sendTalkMessage("▶️ タイムアウト — 対話再開");
    }

    const latestSession = await this.requireSession(sessionId);
    this.stateMachine.resolveHearing(latestSession, answer ?? undefined);
    await this.sessionRepository.save(latestSession);

    const updatedCount = { ...hearingCount };
    updatedCount[side] += 1;
    return updatedCount;
  }

  private async updateParticipantBrief(
    sessionId: string,
    side: ParticipantSide,
    answer: string
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    const participant = session.getParticipant(side);
    const currentStructuredContext = participant.brief.structuredContext;
    if (!currentStructuredContext) {
      return;
    }

    const brief = await this.absorbHearingAnswerForSide(side, {
      sessionId,
      structuredContext: currentStructuredContext,
      answer,
    });

    participant.brief.rawInputs.push(answer);
    participant.brief.structuredContext = brief.structuredContext;
    participant.brief.summary = brief.summary;
    await this.sessionRepository.save(session);
  }

  private absorbHearingAnswerForSide(
    side: ParticipantSide,
    params: { sessionId: string; structuredContext: string; answer: string }
  ) {
    if (side === "A") {
      return this.participantAgents.A.absorbHearingAnswer({
        sessionId: params.sessionId,
        currentStructuredContext: asOwnBrief("A", params.structuredContext),
        answer: params.answer,
      });
    }
    return this.participantAgents.B.absorbHearingAnswer({
      sessionId: params.sessionId,
      currentStructuredContext: asOwnBrief("B", params.structuredContext),
      answer: params.answer,
    });
  }

  private async appendTurn(
    sessionId: string,
    side: ParticipantSide,
    message: string
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    session.getCurrentRound().turns.push({
      speakerSide: side,
      message,
      createdAt: Date.now(),
    });
    await this.sessionRepository.save(session);
  }

  // 現在のラウンドを判定フェーズへ移し、審判AIに評価させて結果を公開する。
  // 第一審: 対話全文を根拠に判定
  // 再審・最終審: 第一審の対話全文 + 過去判定 + 最新異議を根拠に再評価
  private async judgeCurrentRound(sessionId: string): Promise<void> {
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
    const judgment = await this.refereeGateway.judgeRound({
      courtLevel: currentRound.courtLevel,
      contextA: session.getParticipant("A").brief.structuredContext || "",
      contextB: session.getParticipant("B").brief.structuredContext || "",
      goalA: session.getParticipant("A").brief.goal,
      goalB: session.getParticipant("B").brief.goal,
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

  // appeal_pending 時に上告権のある側へDMで「異議ある？」と問い合わせる。
  // - 勝敗あり: 敗者のみに送る
  // - 引き分け: 双方に送り、先に異議を出した側の申し立てを採用する
  // 返信が来たら上告審ラウンドを作って true を返す（次の judgeCurrentRound が呼ばれる）。
  // タイムアウトか異議なしなら session を finished にして false を返す。
  private async handleAppealCycle(sessionId: string): Promise<boolean> {
    const session = await this.requireSession(sessionId);
    const eligibleSides = [...session.appealableSides];
    if (eligibleSides.length === 0) {
      return false;
    }

    // 【重要】リスナー登録は #talk や DM の案内送信よりも先に行う。
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
      await this.messageGateway.sendDm(
        side,
        `⚖️ 判定出た。納得いかないなら異議をDMで送って。\n` +
          `理由を具体的に書くほど${nextCourtLabel}で覆せる可能性が上がる。\n` +
          `${timeoutSec}秒以内に送らなければこのまま確定する。` +
          suggestionBlock
      );
    }

    const appealed = await appealPromise;

    const latestSession = await this.requireSession(sessionId);

    if (!appealed || !appealed.response.trim()) {
      this.stateMachine.expireAppeal(latestSession);
      await this.sessionRepository.save(latestSession);
      await this.messageGateway.sendTalkMessage(
        "⏳ 異議なし。判定が確定した。"
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

    await this.messageGateway.sendDm(appealed.side, "📨 異議受理。再審に回す。");
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
    const participant = session.getParticipant(side);
    const briefText = participant.brief.structuredContext || "";
    const goal = participant.brief.goal;

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

  private async finalizeSession(sessionId: string): Promise<void> {
    await this.messageGateway.sendTalkMessage(
      "━━━\n終了。もう1回やるならBotに「リセット」ってDMして。\n━━━"
    );

    this.participantAgents.A.resetSession(sessionId);
    this.participantAgents.B.resetSession(sessionId);
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
      lines.push(`${name.padEnd(MAX_NAME_LENGTH)} A: ${scoreA}/5  B: ${scoreB}/5`);
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
