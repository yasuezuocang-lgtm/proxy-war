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
  B_AGENT_PERSONALITY,
  B_HEARING_PATTERN,
  buildBAppealSuggestionPrompt,
  buildBSystemPrompt,
  buildBTurnInstruction,
} from "./prompts/b-agent.js";

interface BSessionMemory {
  hearingAnswers: string[];
  strategyMemo: StrategyMemo[];
}

// B 側専属代理人（SPEC §8.2）。
// - Base クラス継承なし・A 側と実装を共有しない独立クラス
// - A 側の brief / context / memo には一切アクセスしない（OwnBrief<"B"> で型封じ）
// - SPEC §8.2 の ParticipantAgent<"B"> を実装
// - DebateOrchestrator（P1-6 で縮退予定）から呼ばれる Legacy 互換メソッド
//   (generateTurn / resetSession / suggestAppealPoints / getLastBrief) は、
//   bot/client.ts の Adapter が結線する公開メソッドとしてこのクラスに残す。
export class BAgent implements ParticipantAgent<"B"> {
  readonly side = "B" as const;
  readonly personality: AgentPersonality = B_AGENT_PERSONALITY;

  private readonly memoryBySession = new Map<string, BSessionMemory>();
  private readonly stashedBriefBySession = new Map<string, StructuredBrief>();
  // P1-12/H3: B側が直前に投げた HEARING の質問を保持して、次の absorbHearingAnswer で
  // Q+A を 1 エントリとして戦術メモに構造化追記する。executeTurn と
  // reviewHearingAnswer の両経路で書き込み、absorb 実行時に delete して使い切る。
  // AAgent と機能は揃えるが、コードは共有せず B 側に閉じた独立実装にする（SPEC §8.2）。
  private readonly lastHearingQuestionBySession = new Map<string, string>();
  private mostRecentSessionId: string | null = null;

  constructor(
    private readonly llmClient: LLMClient,
    private readonly llmGateway: ParticipantLlmGateway
  ) {}

  // ── SPEC §8.2 新インターフェース ───────────────────────────

  async generateOpeningTurn(
    input: AgentTurnInput<"B">
  ): Promise<AgentTurnResult> {
    return this.executeTurn(input);
  }

  async generateReplyTurn(
    input: AgentTurnInput<"B">
  ): Promise<AgentTurnResult> {
    return this.executeTurn(input);
  }

  async absorbHearingAnswer(
    input: AbsorbHearingAnswerInput<"B">
  ): Promise<void> {
    const memory = this.rememberSession(input.sessionId);
    memory.hearingAnswers.push(input.answer);
    // P1-12/H3: 直前に B 側が投げた質問が手元にあれば、戦術メモは
    // 「質問→回答」のペア形式で追記する。無い時（外部差し込みなど）は
    // 回答だけを memo に残して後方互換を維持する。
    const askedQuestion = this.lastHearingQuestionBySession.get(input.sessionId);
    const memoEntry = askedQuestion
      ? `【Q】${askedQuestion} → 【A】${input.answer}`
      : input.answer;
    memory.strategyMemo.push({
      addedAt: Date.now(),
      content: memoEntry,
      source: "hearing_answer",
    });
    // 使い切ったキャッシュは捨て、同じ Q を二度束ねないようにする。
    // 追撃質問は reviewHearingAnswer が改めて書き込む。
    this.lastHearingQuestionBySession.delete(input.sessionId);

    // SPEC §8.2 は Promise<void>。ただし DebateOrchestrator（Legacy 経路）は
    // 追記後の StructuredBrief を必要とするため、ここで生成した brief は
    // stashedBriefBySession に置き、getLastBrief() で取り出せるようにする。
    const integrated = await this.llmGateway.appendBrief({
      currentStructuredContext: input.currentStructuredContext,
      additionalInput: input.answer,
    });
    this.stashedBriefBySession.set(input.sessionId, integrated);
  }

  // SPEC §6.6 / P1-11（H2）: ヒアリング回答が具体的事実として使えるかを判定し、
  // 浅ければ追撃質問を返す。A 側と独立に BAgent に閉じて実装（SPEC §8.2）。
  async reviewHearingAnswer(
    input: ReviewHearingAnswerInput<"B">
  ): Promise<HearingAnswerReview> {
    const reviewSystem = `お前はB側専属代理人。Bへ投げた質問と、Bが返してきた回答を付き合わせて、
反論で使えるだけの具体性が回答に乗ったか判定する。

【判定基準】
- 回答に日時・人物・場所・数量のどれかが入っている → 追撃不要
- 「多分」「そんな感じ」「どうだったかな」等で事実が欠けている → 追撃する
- Aの発言に対する反論に直結する事実が足りない → 追撃する

【追撃する場合】
- [HEARING:具体的な質問|追撃する理由] の形式で返す
- 質問は「いつ・誰が・何を・どこで・どれくらい」のどれかを必ず含める
- 同じ角度の再質問にはせず、回答で抜け落ちた事実を一点だけ突く

【追撃しない場合】
- [SUFFICIENT] とだけ返す

前置きや説明は書くな。上の2書式どちらかだけを返せ。`;

    const userText =
      `直前にBへ投げた質問:\n${input.question}\n\n` +
      `Bからの回答:\n${input.answer}\n\n判定しろ。`;

    let response: string;
    try {
      response = await this.chat([
        { role: "system", content: reviewSystem },
        { role: "user", content: userText },
      ]);
    } catch {
      // 追撃判定が取れない時は対話再開を優先（sufficient で打ち切り）。
      return { type: "sufficient" };
    }

    const hearing = response.match(B_HEARING_PATTERN);
    if (!hearing) {
      return { type: "sufficient" };
    }
    const question = hearing[1].trim();
    // 追撃でも具体性（H1）は必須。抽象なら追撃を打ち切る。
    if (!BAgent.isConcreteHearingQuestion(question)) {
      return { type: "sufficient" };
    }
    const reason =
      (hearing[2] || "").trim() || "Bの回答に事実が乗っていないため";
    // P1-12/H3: 追撃質問も次の absorbHearingAnswer で Q+A を束ねるためにキャッシュ。
    this.lastHearingQuestionBySession.set(input.sessionId, question);
    return { type: "followup", question, reason };
  }

  getStrategyMemo(): string {
    const sid = this.mostRecentSessionId;
    if (!sid) return "";
    const memory = this.memoryBySession.get(sid);
    if (!memory || memory.strategyMemo.length === 0) return "";
    return memory.strategyMemo.map((entry) => entry.content).join("\n");
  }

  // ── Legacy 互換メソッド（P1-6 の DebateCoordinator 移行まで） ─────
  // クラスに implements LegacyParticipantAgent<"B"> は付けない。
  // Adapter 側で必要メソッドだけ取り出すためにこのメソッド群を残す。

  async generateTurn(
    input: AgentTurnInput<"B">
  ): Promise<LegacyAgentTurnResult> {
    const result = await this.executeTurn(input);
    if (result.type === "hearing") {
      return { type: "hearing", question: result.question };
    }
    return result;
  }

  resetSession(sessionId: string): void {
    this.memoryBySession.delete(sessionId);
    this.stashedBriefBySession.delete(sessionId);
    this.lastHearingQuestionBySession.delete(sessionId);
    if (this.mostRecentSessionId === sessionId) {
      this.mostRecentSessionId = null;
    }
  }

  async suggestAppealPoints(input: SuggestAppealInput<"B">): Promise<string> {
    const system = buildBAppealSuggestionPrompt({
      ownBrief: input.brief,
      goal: input.goal,
      nextCourtLevel: input.nextCourtLevel,
    });

    const dialogueText =
      input.dialogue.length === 0
        ? "（対話ログなし）"
        : input.dialogue
            .map((turn) => `${turn.speaker}側: ${turn.message}`)
            .join("\n\n");

    const judgmentText = this.renderJudgmentForAppeal(input.judgment);
    const nextCourtLabel = COURT_LABELS[input.nextCourtLevel];

    try {
      const response = await this.chat([
        { role: "system", content: system },
        {
          role: "user",
          content:
            `## 前審の判定結果\n${judgmentText}\n\n` +
            `## 第一審の対話全文\n${dialogueText}\n\n` +
            `上記を踏まえて、B側の依頼人が${nextCourtLabel}で主張すべき` +
            `異議の材料を2〜3個、箇条書きで提案しろ。`,
        },
      ]);
      return response.trim();
    } catch {
      // 提案に失敗しても異議申し立て自体は通す必要があるので、
      // 空文字を返して呼び出し側で DM のセクションごと省略させる。
      return "";
    }
  }

  // absorbHearingAnswer で生成した StructuredBrief を取り出す。
  // Adapter 経由で DebateOrchestrator が participant.brief を更新する。
  getLastBrief(sessionId: string): StructuredBrief | null {
    return this.stashedBriefBySession.get(sessionId) ?? null;
  }

  // ── 内部実装 ────────────────────────────────────────────

  private async executeTurn(
    input: AgentTurnInput<"B">
  ): Promise<AgentTurnResult> {
    this.mostRecentSessionId = input.sessionId;
    const memory = this.rememberSession(input.sessionId);

    const systemPrompt = buildBSystemPrompt({
      ownBrief: input.brief,
      goal: input.goal,
      hearingAnswers: memory.hearingAnswers,
      strategyMemo: memory.strategyMemo.map((entry) => entry.content),
    });

    const baseMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.renderConversation(input.conversation),
      { role: "user", content: buildBTurnInstruction(input.turnIndex) },
    ];

    let raw = await this.chat(baseMessages);
    let hearing = raw.match(B_HEARING_PATTERN);

    // P1-9/H1: HEARING の質問が抽象的（「状況を聞かせて」等）なら一度だけ
    // 書き直しを要求する。具体性マーカー（いつ/誰/何/どこ/数字）を強制。
    if (hearing && !BAgent.isConcreteHearingQuestion(hearing[1].trim())) {
      const retryMessages: LLMMessage[] = [
        ...baseMessages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            "その質問は抽象的すぎる。「いつ」「誰が」「何を」「どこで」のいずれかを含む具体的な質問に書き直せ。書式は [HEARING:質問|理由] のまま。",
        },
      ];
      raw = await this.chat(retryMessages);
      hearing = raw.match(B_HEARING_PATTERN);
    }

    if (hearing) {
      const question = hearing[1].trim();
      // P1-8/H4: 武器リストに既に情報がある時は HEARING を乱発させず、
      // コード側で message に変換する（プロンプト制約と二重で守る）。
      if (memory.hearingAnswers.length > 0) {
        return { type: "message", message: question };
      }
      const reason =
        (hearing[2] || "").trim() || "B側の反論材料が足りないため";
      // P1-12/H3: 次の absorbHearingAnswer で質問と回答を 1 エントリに束ねるため
      // B 側の質問文をキャッシュ。absorb 実行時に捨てて寿命は 1 往復だけ。
      this.lastHearingQuestionBySession.set(input.sessionId, question);
      return { type: "hearing", question, reason };
    }

    return { type: "message", message: raw.trim() };
  }

  // P1-9/H1: ヒアリング質問の具体性判定。
  // 5W1H（いつ・誰・何・どこ・なぜ・どれ・どの）、頻度語（毎日/毎週/毎回）、
  // 事実確認語（実際・本当・具体）、数字のいずれかを含めば具体質問とみなす。
  // A 側と独立に BAgent に閉じ込める（SPEC §8.2「コード非共有」のため重複）。
  private static isConcreteHearingQuestion(question: string): boolean {
    return /いつ|誰|何|どこ|なぜ|どれ|どの|毎|実際|本当|具体|[0-9０-９]/.test(
      question
    );
  }

  private renderConversation(conversation: PublicTurn[]): LLMMessage[] {
    // 自分（B）の発言は assistant ロール、相手（A）は user ロールで
    // LLM に渡す。これで B 側から見た会話履歴になる。
    return conversation.map((turn) => ({
      role: turn.speaker === "B" ? "assistant" : "user",
      content: turn.message,
    }));
  }

  private async chat(messages: LLMMessage[]): Promise<string> {
    const reply = await this.llmClient.chat(messages);
    return reply.content;
  }

  private rememberSession(sessionId: string): BSessionMemory {
    this.mostRecentSessionId = sessionId;
    const existing = this.memoryBySession.get(sessionId);
    if (existing) return existing;

    const fresh: BSessionMemory = {
      hearingAnswers: [],
      strategyMemo: [],
    };
    this.memoryBySession.set(sessionId, fresh);
    return fresh;
  }

  private renderJudgmentForAppeal(judgment: {
    winner: "A" | "B" | "draw";
    totalA: number;
    totalB: number;
    summary: string;
    criteria: { name: string; scoreA: number; scoreB: number; reason: string }[];
  }): string {
    const winnerText =
      judgment.winner === "draw" ? "引き分け" : `${judgment.winner}側の勝ち`;
    const rows = judgment.criteria
      .map((c) => `- ${c.name}: A=${c.scoreA}/5 B=${c.scoreB}/5 / ${c.reason}`)
      .join("\n");
    return (
      `勝者: ${winnerText}\n` +
      `合計 A: ${judgment.totalA} / B: ${judgment.totalB}\n` +
      `採点:\n${rows}\n\n` +
      `総評: ${judgment.summary}`
    );
  }
}
