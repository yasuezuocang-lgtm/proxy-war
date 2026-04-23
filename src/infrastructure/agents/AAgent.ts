import type { LLMClient, LLMMessage } from "../../llm/provider.js";
import type {
  AbsorbHearingAnswerInput,
  AgentTurnInput,
  AgentTurnResult,
  HearingAnswerReview,
  LegacyAgentTurnResult,
  ParticipantAgent,
  PublicTurn,
  ReviewHearingAnswerInput,
  SuggestAppealInput,
} from "../../application/ports/ParticipantAgent.js";
import type {
  ParticipantLlmGateway,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
import type {
  AgentPersonality,
  StrategyMemo,
} from "../../domain/entities/AgentContext.js";
import { COURT_LABELS } from "../../domain/value-objects/CourtLevel.js";
import {
  A_AGENT_PERSONALITY,
  A_HEARING_PATTERN,
  buildAAppealSuggestionPrompt,
  buildASystemPrompt,
  buildATurnInstruction,
} from "./prompts/a-agent.js";

interface ASessionState {
  hearingAnswers: string[];
  strategyMemo: StrategyMemo[];
}

// A 側専属代理人（SPEC §8.2）。
// - Base クラス継承なしの独立実装。B 側とコードを共有しない
// - B 側の brief / context には一切アクセスしない（型レベルでも OwnBrief<"A"> で強制）
// - SPEC §8.2 の新 ParticipantAgent<"A"> を実装する
// - DebateOrchestrator（P1-6 で縮退予定）から使うための Legacy 互換メソッド
//   （generateTurn / resetSession / suggestAppealPoints / getLastBrief）は
//   bot/client.ts のインライン Adapter が呼ぶ公開メソッドとして残す
export class AAgent implements ParticipantAgent<"A"> {
  readonly side = "A" as const;
  readonly personality: AgentPersonality = A_AGENT_PERSONALITY;

  private readonly sessions = new Map<string, ASessionState>();
  private readonly lastBriefBySession = new Map<string, StructuredBrief>();
  // P1-12/H3: 直近に A 側が投げた HEARING の質問を保持し、次の absorbHearingAnswer で
  // Q+A を 1 エントリに束ねて戦術メモへ構造化追記するためのキャッシュ。
  // runTurn（type:"hearing"）と reviewHearingAnswer（type:"followup"）の両経路で書き込む。
  private readonly lastHearingQuestionBySession = new Map<string, string>();
  private lastSessionId: string | null = null;

  constructor(
    private readonly llmClient: LLMClient,
    private readonly llmGateway: ParticipantLlmGateway
  ) {}

  // ── SPEC §8.2 新インターフェース ─────────────────────────

  async generateOpeningTurn(
    input: AgentTurnInput<"A">
  ): Promise<AgentTurnResult> {
    return this.runTurn(input);
  }

  async generateReplyTurn(
    input: AgentTurnInput<"A">
  ): Promise<AgentTurnResult> {
    return this.runTurn(input);
  }

  async absorbHearingAnswer(
    input: AbsorbHearingAnswerInput<"A">
  ): Promise<void> {
    const state = this.getSessionState(input.sessionId);
    state.hearingAnswers.push(input.answer);
    // P1-12/H3: 直前に自分が投げた質問が記憶にあれば、戦術メモは「質問→回答」の
    // 構造化エントリとして追記する。キャッシュが無い場合（外部経路から差し込まれた
    // 回答など）は、後方互換で回答文そのものを記録する。
    const askedQuestion = this.lastHearingQuestionBySession.get(input.sessionId);
    const memoContent = askedQuestion
      ? `【Q】${askedQuestion} → 【A】${input.answer}`
      : input.answer;
    state.strategyMemo.push({
      addedAt: Date.now(),
      content: memoContent,
      source: "hearing_answer",
    });
    // 同じ質問を二重に束ねないよう、使い切った質問キャッシュは捨てる。
    // 追撃質問（followup）が来た時は reviewHearingAnswer 側で改めて書き込む。
    this.lastHearingQuestionBySession.delete(input.sessionId);

    // SPEC §8.2 は Promise<void>。返り値は呼び出し側に渡さないが、
    // 統合された brief は DebateOrchestrator（Legacy 経路）で必要なので
    // lastBriefBySession に stash し、getLastBrief() で取り出せるようにする。
    const brief = await this.llmGateway.appendBrief({
      currentStructuredContext: input.currentStructuredContext,
      additionalInput: input.answer,
    });
    this.lastBriefBySession.set(input.sessionId, brief);
  }

  // SPEC §6.6 / P1-11（H2）: 直近の質問と回答を見て追撃するか判断する。
  // A 側のロジックを BAgent と共有しない（SPEC §8.2）。
  async reviewHearingAnswer(
    input: ReviewHearingAnswerInput<"A">
  ): Promise<HearingAnswerReview> {
    const reviewSystem = `お前はA側専属代理人。依頼人Aに投げた質問と、Aから戻ってきた回答を突き合わせて、
反論材料として使えるレベルまで具体的に答えが埋まったかを判定する。

【基準】
- 回答に「いつ」「誰が」「何を」「どこで」「数字（日付・回数）」のいずれかが入っている → 使える
- 「わからない」「覚えてない」「多分」で濁されている → 追撃しろ
- 抽象的（「そういう感じ」「いつもそう」）で事実が抜けている → 追撃しろ

【追撃するときの書き方】
- [HEARING:具体的な質問|追撃する理由] の形式で返す
- 質問は「いつ・誰・何・どこ・数字」のどれかを必ず含む
- 同じ角度を繰り返さず、回答で抜けた事実を一点だけ突く

【追撃しないときの書き方】
- [SUFFICIENT] とだけ返す

前置き・説明は書くな。どちらかの書式だけを返せ。`;

    const userMessage =
      `直前にAへ投げた質問:\n${input.question}\n\n` +
      `Aからの回答:\n${input.answer}\n\n判定しろ。`;

    let response: string;
    try {
      response = await this.chat([
        { role: "system", content: reviewSystem },
        { role: "user", content: userMessage },
      ]);
    } catch {
      // LLM エラーで追撃判定が取れない時は追撃しない（対話継続を優先）。
      return { type: "sufficient" };
    }

    const hearing = response.match(A_HEARING_PATTERN);
    if (!hearing) {
      return { type: "sufficient" };
    }
    const question = hearing[1].trim();
    // 追撃質問も具体性制約（H1）を満たすこと。抽象なら追撃せず打ち切る。
    if (!AAgent.isConcreteHearingQuestion(question)) {
      return { type: "sufficient" };
    }
    const reason =
      (hearing[2] || "").trim() || "Aの回答に事実が埋まっていないため";
    // P1-12/H3: 追撃質問も次の absorbHearingAnswer で Q+A を束ねるためにキャッシュする。
    this.lastHearingQuestionBySession.set(input.sessionId, question);
    return { type: "followup", question, reason };
  }

  getStrategyMemo(): string {
    const sessionId = this.lastSessionId;
    if (!sessionId) return "";
    const state = this.sessions.get(sessionId);
    if (!state || state.strategyMemo.length === 0) return "";
    return state.strategyMemo.map((memo) => memo.content).join("\n");
  }

  // ── Legacy 互換メソッド（P1-6 の DebateCoordinator 移行まで） ─────
  // LegacyParticipantAgent<"A"> を class level で implements せず、
  // 必要なメソッドだけ残す。Legacy 経路は bot/client.ts の Adapter が結線する。

  async generateTurn(
    input: AgentTurnInput<"A">
  ): Promise<LegacyAgentTurnResult> {
    const result = await this.runTurn(input);
    if (result.type === "hearing") {
      return { type: "hearing", question: result.question };
    }
    return result;
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastBriefBySession.delete(sessionId);
    this.lastHearingQuestionBySession.delete(sessionId);
    if (this.lastSessionId === sessionId) {
      this.lastSessionId = null;
    }
  }

  async suggestAppealPoints(input: SuggestAppealInput<"A">): Promise<string> {
    const system = buildAAppealSuggestionPrompt({
      ownBrief: input.brief,
      goal: input.goal,
      nextCourtLevel: input.nextCourtLevel,
    });

    const dialogueBlock =
      input.dialogue.length > 0
        ? input.dialogue
            .map((turn) => `${turn.speaker}側: ${turn.message}`)
            .join("\n\n")
        : "（対話ログなし）";

    const judgmentBlock = this.formatJudgmentForAppeal(input.judgment);
    const nextCourtLabel = COURT_LABELS[input.nextCourtLevel];

    try {
      const response = await this.chat([
        { role: "system", content: system },
        {
          role: "user",
          content:
            `## 前審の判定結果\n${judgmentBlock}\n\n` +
            `## 第一審の対話全文\n${dialogueBlock}\n\n` +
            `上記を踏まえて、A側の依頼人が${nextCourtLabel}で主張すべき` +
            `異議の材料を2〜3個、箇条書きで提案しろ。`,
        },
      ]);
      return response.trim();
    } catch {
      // 提案生成に失敗しても異議申し立て自体はできる必要がある。
      // 空文字で返して呼び出し側で DM セクションごと省略させる。
      return "";
    }
  }

  // absorbHearingAnswer で統合された brief を取り出す。Adapter 経由で
  // DebateOrchestrator が participant.brief を更新するために使う。
  getLastBrief(sessionId: string): StructuredBrief | null {
    return this.lastBriefBySession.get(sessionId) ?? null;
  }

  // ── 内部実装 ────────────────────────────────────────────

  private async runTurn(input: AgentTurnInput<"A">): Promise<AgentTurnResult> {
    this.lastSessionId = input.sessionId;
    const state = this.getSessionState(input.sessionId);

    const systemPrompt = buildASystemPrompt({
      ownBrief: input.brief,
      goal: input.goal,
      hearingAnswers: state.hearingAnswers,
      strategyMemo: state.strategyMemo.map((memo) => memo.content),
    });

    const baseMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.buildConversationMessages(input.conversation),
      { role: "user", content: buildATurnInstruction(input.turnIndex) },
    ];

    let response = await this.chat(baseMessages);
    let hearingMatch = response.match(A_HEARING_PATTERN);

    // P1-9/H1: HEARING の質問が抽象的（「状況を教えて」等）なら一度だけ
    // 書き直しを要求する。「いつ・誰・何」を含む具体質問を強制。
    if (
      hearingMatch &&
      !AAgent.isConcreteHearingQuestion(hearingMatch[1].trim())
    ) {
      const retryMessages: LLMMessage[] = [
        ...baseMessages,
        { role: "assistant", content: response },
        {
          role: "user",
          content:
            "その質問は抽象的すぎる。「いつ」「誰が」「何を」「どこで」のいずれかを含む具体的な質問に書き直せ。書式は [HEARING:質問|理由] のまま。",
        },
      ];
      response = await this.chat(retryMessages);
      hearingMatch = response.match(A_HEARING_PATTERN);
    }

    if (hearingMatch) {
      const question = hearingMatch[1].trim();
      // P1-8/H4: 武器リストに既に反論材料が積まれている時は、LLM が
      // 誤発火した HEARING をコード側で抑止し通常発言に変換する。
      // プロンプト制約の二重防御（乱発防止）。
      if (state.hearingAnswers.length > 0) {
        return { type: "message", message: question };
      }
      const reason =
        (hearingMatch[2] || "").trim() || "A側の反論材料が足りないため";
      // P1-12/H3: 次の absorbHearingAnswer で質問と回答を 1 エントリに束ねるため
      // にキャッシュする。absorb 実行時に delete されるので寿命は 1 往復だけ。
      this.lastHearingQuestionBySession.set(input.sessionId, question);
      return { type: "hearing", question, reason };
    }

    return { type: "message", message: response.trim() };
  }

  // P1-9/H1: ヒアリング質問の具体性判定。
  // 5W1H（いつ・誰・何・どこ・なぜ・どれ・どの）、頻度語（毎日/毎週/毎回）、
  // 事実確認語（実際・本当・具体）、数字（日付・回数）のいずれかを含めば
  // 具体質問とみなす。どれも無ければ抽象質問として再生成を要求する。
  // B 側と独立したロジックとして AAgent に閉じ込める（SPEC §8.2 コード非共有）。
  private static isConcreteHearingQuestion(question: string): boolean {
    return /いつ|誰|何|どこ|なぜ|どれ|どの|毎|実際|本当|具体|[0-9０-９]/.test(
      question
    );
  }

  private buildConversationMessages(conversation: PublicTurn[]): LLMMessage[] {
    return conversation.map((turn) => ({
      role: turn.speaker === "A" ? "assistant" : "user",
      content: turn.message,
    }));
  }

  private async chat(messages: LLMMessage[]): Promise<string> {
    const response = await this.llmClient.chat(messages);
    return response.content;
  }

  private getSessionState(sessionId: string): ASessionState {
    this.lastSessionId = sessionId;
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: ASessionState = {
      hearingAnswers: [],
      strategyMemo: [],
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private formatJudgmentForAppeal(judgment: {
    winner: "A" | "B" | "draw";
    totalA: number;
    totalB: number;
    summary: string;
    criteria: { name: string; scoreA: number; scoreB: number; reason: string }[];
  }): string {
    const winnerText =
      judgment.winner === "draw" ? "引き分け" : `${judgment.winner}側の勝ち`;
    const criteriaLines = judgment.criteria
      .map((c) => `- ${c.name}: A=${c.scoreA}/5 B=${c.scoreB}/5 / ${c.reason}`)
      .join("\n");
    return (
      `勝者: ${winnerText}\n` +
      `合計 A: ${judgment.totalA} / B: ${judgment.totalB}\n` +
      `採点:\n${criteriaLines}\n\n` +
      `総評: ${judgment.summary}`
    );
  }
}
