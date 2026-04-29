import { loadAppConfig } from "../../config.js";
import type { SessionRepository } from "../ports/SessionRepository.js";
import type { LlmGateway } from "../ports/LlmGateway.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type { ParticipantResponseGateway } from "../ports/ParticipantResponseGateway.js";
import type {
  AgentTurnResult,
  DebateAgent,
  DebateAgents,
  HearingAnswerReview,
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

// DebateOrchestrator は「司会（DebateCoordinator）」として振る舞う。
// 責務はターン順管理・ラウンド進行・判定起動・上告サイクル調整。
// 発言の中身を作るのは各 ParticipantAgent 側に委譲し、
// ここは「誰に喋らせるか」と「結果をどう配信するか」だけを扱う（SPEC §8.2 / P1-6）。
export class DebateOrchestrator {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly stateMachine: SessionStateMachine,
    private readonly participantAgents: DebateAgents,
    // 司会は判定（RefereeLlmGateway）と最終審の敗者 Consolation DM（ParticipantLlmGateway）の
    // 両方を使うため、合成型 LlmGateway を受け取る。
    // 代理対話の LLM 呼び出しは participantAgents 側へ完全に委譲済みで、
    // ここから A/B の brief 抽出や追加質問生成は呼ばない（SPEC §8.2）。
    private readonly llmGateway: LlmGateway,
    private readonly messageGateway: MessageGateway,
    private readonly participantResponseGateway: ParticipantResponseGateway,
    private readonly turnDelayMs = loadAppConfig().debate.turnDelayMs,
    // SPEC §9 / P1-11（H2）: 1ヒアリングあたりの追撃上限。
    // SessionPolicy を変えずにここで持つ（既存 policy は最小構成のため）。
    private readonly maxHearingFollowups = loadAppConfig().hearing
      .maxHearingFollowups
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

      // #talk に「誰のAIが考え中か」をテキストで通知し、
      // Discord ネイティブの入力中アニメーションも並行して送る。
      await this.messageGateway.sendTalkMessage(
        `💬 **${currentSide}代理AI** — 考え中...`
      );
      await this.messageGateway.sendTalkTyping?.(currentSide);

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
          result.question,
          result.reason
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
  //
  // turnIndex===0 は開幕ターン → generateOpeningTurn。
  // 以降は generateReplyTurn。ヒアリングで 1 ターン消費しなかった場合も
  // 完了済みターン番号に応じて opening/reply を切り替える。
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
    agent: DebateAgent<Side>,
    params: {
      sessionId: string;
      briefText: string;
      goal: string | null;
      conversation: PublicTurn[];
      turnIndex: number;
    }
  ): Promise<AgentTurnResult> {
    const turnInput = {
      sessionId: params.sessionId,
      brief: asOwnBrief(side, params.briefText),
      goal: params.goal,
      conversation: params.conversation,
      turnIndex: params.turnIndex,
    };
    if (params.turnIndex === 0) {
      return agent.generateOpeningTurn(turnInput);
    }
    return agent.generateReplyTurn(turnInput);
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
    question: string,
    reason: string
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

    // 初回の質問 → 回答 → 追撃ループ。
    // 追撃（H2）は「回答が浅い時のみ」最大 maxHearingFollowups 回まで繰り返す。
    // タイムアウト時は追撃せず対話再開（ユーザーが離席している可能性が高い）。
    let currentQuestion = question;
    let currentReason = reason;
    let lastAnswer: string | null = null;
    let followupsUsed = 0;

    while (true) {
      await this.sendHearingDm(side, currentQuestion, currentReason);

      const answer = await this.participantResponseGateway.waitForResponse(
        side,
        session.policy.hearingTimeoutMs
      );

      if (!answer) {
        lastAnswer = null;
        break;
      }

      await this.updateParticipantBrief(sessionId, side, answer);
      lastAnswer = answer;

      if (followupsUsed >= this.maxHearingFollowups) {
        break;
      }

      const review = await this.reviewHearingAnswerForSide(
        sessionId,
        side,
        currentQuestion,
        answer
      );
      if (review.type === "sufficient") {
        break;
      }

      followupsUsed += 1;
      currentQuestion = review.question;
      currentReason = review.reason;
      await this.messageGateway.sendTalkMessage(
        `🔁 ${side}側に追撃質問（${followupsUsed}/${this.maxHearingFollowups}）...`
      );
    }

    if (lastAnswer) {
      await this.messageGateway.sendTalkMessage("▶️ ヒアリング完了 — 対話再開");
    } else {
      await this.messageGateway.sendTalkMessage("▶️ タイムアウト — 対話再開");
    }

    const latestSession = await this.requireSession(sessionId);
    this.stateMachine.resolveHearing(latestSession, lastAnswer ?? undefined);
    await this.sessionRepository.save(latestSession);

    const updatedCount = { ...hearingCount };
    updatedCount[side] += 1;
    return updatedCount;
  }

  private sendHearingDm(
    side: ParticipantSide,
    question: string,
    reason: string
  ): Promise<void> {
    // SPEC H5: 依頼人には「なぜ聞くか」を質問本文と一緒に見せる。
    // reason が空文字列の場合は理由ブロックを省略（抽象フォールバックで
    // 質問だけが埋まるケースを想定）。
    const reasonBlock = reason.trim()
      ? `\n\n【確認したい理由】\n${reason.trim()}`
      : "";
    return this.messageGateway.sendDm(
      side,
      `⏸️ 対話中に確認したいことが出た。\n\n${question}${reasonBlock}\n\n返信して。終わったら対話再開する。`
    );
  }

  private async reviewHearingAnswerForSide(
    sessionId: string,
    side: ParticipantSide,
    question: string,
    answer: string
  ): Promise<HearingAnswerReview> {
    const session = await this.requireSession(sessionId);
    const participant = session.getParticipant(side);
    const currentStructuredContext = participant.brief.structuredContext || "";

    if (side === "A") {
      return this.participantAgents.A.reviewHearingAnswer({
        sessionId,
        currentStructuredContext: asOwnBrief("A", currentStructuredContext),
        question,
        answer,
      });
    }
    return this.participantAgents.B.reviewHearingAnswer({
      sessionId,
      currentStructuredContext: asOwnBrief("B", currentStructuredContext),
      question,
      answer,
    });
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

    // SPEC §8.2 で absorbHearingAnswer は Promise<void>。
    // agent は内部で武器リストへの追記 + brief 統合 + stash を行う。
    // 司会（このクラス）は後から getLastBrief() で統合 brief を取り出して
    // session.participant.brief を更新する（司法に渡すのは session 由来のため）。
    await this.absorbHearingAnswerForSide(side, {
      sessionId,
      structuredContext: currentStructuredContext,
      answer,
    });

    const stashed = this.getLastBriefForSide(sessionId, side);
    if (!stashed) {
      // agent が stash に失敗した場合（通常フローでは起きない）。
      // session.brief を書き換えられないが、agent 側の記憶は更新済みなので
      // 続行して次ターンへ進める。
      participant.brief.rawInputs.push(answer);
      await this.sessionRepository.save(session);
      return;
    }

    participant.brief.rawInputs.push(answer);
    participant.brief.structuredContext = stashed.structuredContext;
    participant.brief.summary = stashed.summary;
    await this.sessionRepository.save(session);
  }

  private absorbHearingAnswerForSide(
    side: ParticipantSide,
    params: { sessionId: string; structuredContext: string; answer: string }
  ): Promise<void> {
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

  private getLastBriefForSide(sessionId: string, side: ParticipantSide) {
    if (side === "A") {
      return this.participantAgents.A.getLastBrief(sessionId);
    }
    return this.participantAgents.B.getLastBrief(sessionId);
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
    const judgment = await this.llmGateway.judgeRound({
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
      // SPEC §6.8 / P1-15: AppealExpired イベント発火。
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
    await this.sendConsolationDmToLoser(sessionId);

    await this.messageGateway.sendTalkMessage(
      "━━━\n終了。もう1回やるならBotに「リセット」ってDMして。\n━━━"
    );

    this.participantAgents.A.resetSession(sessionId);
    this.participantAgents.B.resetSession(sessionId);
  }

  // SPEC §6.9 / P1-17: 最終審（または上告放棄）で敗者が確定した場合、
  // その敗者だけに振り返りメッセージを DM で送る。
  //   - 引き分け: 誰が「敗者」か決まっていないので送らない
  //   - 判決未実施: 異常系なので送らない
  //   - LLM が空文字列を返した: DM 本体が空になるので送らない
  //   - LLM エラー: 握りつぶす（セッション終了フロー自体は止めない）
  // 判決履歴は第一審〜最終審までの summary を順に渡して「どう転んだか」を
  // 代理人側で参照できるようにする。
  private async sendConsolationDmToLoser(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const latestJudgment = session.rounds.at(-1)?.judgment;
    if (!latestJudgment || latestJudgment.winner === "draw") {
      return;
    }

    const loserSide: ParticipantSide =
      latestJudgment.winner === "A" ? "B" : "A";
    const loserContext =
      session.getParticipant(loserSide).brief.structuredContext || "";
    const judgmentHistory = session.rounds
      .map((round) => round.judgment)
      .filter((judgment): judgment is Judgment => judgment !== null)
      .map((judgment) => judgment.summary || "");

    let consolation: string;
    try {
      consolation = await this.llmGateway.generateConsolation({
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

    await this.messageGateway.sendDm(
      loserSide,
      `💬 お疲れ。最後にひとこと。\n\n${trimmed}`
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
