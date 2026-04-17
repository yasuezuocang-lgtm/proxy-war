import type { LLMClient, LLMMessage } from "../../llm/provider.js";
import type {
  AbsorbHearingAnswerInput,
  AgentTurnInput,
  AgentTurnResult,
  ParticipantAgent,
  SuggestAppealInput,
} from "../../application/ports/ParticipantAgent.js";
import type {
  ParticipantLlmGateway,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import { COURT_LABELS } from "../../domain/value-objects/CourtLevel.js";
import { PromptCatalog } from "../llm/PromptCatalog.js";

const HEARING_PATTERN = /^\s*\[HEARING:(.+?)\]\s*$/s;

interface AgentMemory {
  hearingAnswers: string[];
}

export abstract class BaseDedicatedParticipantAgent<
  Side extends ParticipantSide
> implements ParticipantAgent<Side>
{
  readonly side: Side;
  private readonly memories = new Map<string, AgentMemory>();

  constructor(
    side: Side,
    private readonly llmClient: LLMClient,
    private readonly llmGateway: ParticipantLlmGateway,
    private readonly prompts: PromptCatalog = new PromptCatalog()
  ) {
    this.side = side;
  }

  async generateTurn(input: AgentTurnInput<Side>): Promise<AgentTurnResult> {
    const memory = this.getMemory(input.sessionId);
    const response = await this.chat([
      {
        role: "system",
        content: this.buildSystemPrompt(input, memory),
      },
      ...this.buildConversation(input),
      {
        role: "user",
        content: this.buildTurnInstruction(input.turnIndex),
      },
    ]);

    const hearingMatch = response.match(HEARING_PATTERN);
    if (hearingMatch) {
      return { type: "hearing", question: hearingMatch[1].trim() };
    }

    return { type: "message", message: response.trim() };
  }

  resetSession(sessionId: string): void {
    this.memories.delete(sessionId);
  }

  async absorbHearingAnswer(
    input: AbsorbHearingAnswerInput<Side>
  ): Promise<StructuredBrief> {
    const memory = this.getMemory(input.sessionId);
    memory.hearingAnswers.push(input.answer);

    return this.llmGateway.appendBrief({
      currentStructuredContext: input.currentStructuredContext,
      additionalInput: input.answer,
    });
  }

  async suggestAppealPoints(
    input: SuggestAppealInput<Side>
  ): Promise<string> {
    const nextCourtLabel = COURT_LABELS[input.nextCourtLevel];
    const system = this.prompts.appealSuggestion(
      this.side,
      input.brief,
      input.goal,
      nextCourtLabel
    );

    const dialogueBlock =
      input.dialogue.length > 0
        ? input.dialogue
            .map((turn) => `${turn.speaker}側: ${turn.message}`)
            .join("\n\n")
        : "（対話ログなし）";

    const judgmentBlock = this.formatJudgmentForAppeal(input.judgment);

    try {
      const response = await this.chat([
        { role: "system", content: system },
        {
          role: "user",
          content:
            `## 前審の判定結果\n${judgmentBlock}\n\n` +
            `## 第一審の対話全文\n${dialogueBlock}\n\n` +
            `上記を踏まえて、${this.side}側の依頼人が${nextCourtLabel}で主張すべき` +
            `異議の材料を2〜3個、箇条書きで提案しろ。`,
        },
      ]);
      return response.trim();
    } catch {
      // 提案生成に失敗しても、異議申し立て自体はできる必要がある。
      // 空文字で返して呼び出し側で無視させる。
      return "";
    }
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
      .map(
        (c) =>
          `- ${c.name}: A=${c.scoreA}/5 B=${c.scoreB}/5 / ${c.reason}`
      )
      .join("\n");
    return (
      `勝者: ${winnerText}\n` +
      `合計 A: ${judgment.totalA} / B: ${judgment.totalB}\n` +
      `採点:\n${criteriaLines}\n\n` +
      `総評: ${judgment.summary}`
    );
  }

  protected buildSystemPrompt(
    input: AgentTurnInput<Side>,
    memory: AgentMemory
  ): string {
    const parts = [this.prompts.proxyBot(this.side, input.brief)];

    if (input.goal) {
      parts.push(`【今回の対話で勝ち取りたいこと】\n${input.goal}`);
    }

    if (memory.hearingAnswers.length > 0) {
      parts.push(
        `【依頼人に追加で聞いたこと】\n${memory.hearingAnswers.join("\n")}`
      );
    }

    parts.push(this.stanceInstruction());

    return parts.join("\n\n");
  }

  protected abstract stanceInstruction(): string;

  private getMemory(sessionId: string): AgentMemory {
    const existing = this.memories.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: AgentMemory = {
      hearingAnswers: [],
    };
    this.memories.set(sessionId, created);
    return created;
  }

  private buildConversation(input: AgentTurnInput<Side>): LLMMessage[] {
    return input.conversation.map((turn) => ({
      role: turn.speaker === this.side ? "assistant" : "user",
      content: turn.message,
    }));
  }

  private async chat(messages: LLMMessage[]): Promise<string> {
    const response = await this.llmClient.chat(messages);
    return response.content;
  }

  private buildTurnInstruction(turnIndex: number): string {
    if (turnIndex === 0) {
      return "自分の言い分と、今一番ひっかかってることを、相手に届く形で切り出せ。";
    }

    if (turnIndex === 1) {
      return "相手が言ったことに反応した上で、自分の立場から反論しろ。";
    }

    return "相手の直前の発言に具体的に返しながら、自分が欲しいものに話を寄せていけ。";
  }
}
