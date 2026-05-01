import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  ParticipantLlmGateway,
  ProbeInput,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { LLMClient, LLMMessage } from "../../llm/provider.js";
import { PromptCatalog } from "./PromptCatalog.js";

const QUESTION_END_PATTERN = /[？?]$/;
const MULTI_SPACE_PATTERN = /\s+/g;
const PROBE_LINE_PREFIX = /^[-*・>\s]+/;
const SUMMARY_BANNED_LINE_PATTERNS = [
  /^相手は誰[？?]?$/,
  /^これで戦う。/,
  /^申し訳ありませんが、私は実際の依頼人ではなく/,
  /どう(言う|答える)[？?]$/,
  /返されたらどう(言う|答える)[？?]$/,
];
const SUMMARY_BANNED_CONTENT_PATTERNS = [
  /案件理解不可/,
  /再依頼せよ/,
  /システムエラー確認済/,
  /代理戦争案件じゃない/,
  /案件終了/,
  /精神科/,
  /出直せ/,
];
const STRUCTURED_SECTION_PATTERN =
  /■([^:\n]+):\s*([\s\S]*?)(?=\n■[^:\n]+:|$)/g;
const LATEST_REVISION_SECTION = "最新の訂正・追加発言";
const LATEST_REVISION_SECTION_PATTERN =
  /\n?■最新の訂正・追加発言:\s*[\s\S]*?(?=\n■[^:\n]+:|$)/g;

export class PromptDrivenLlmGateway implements ParticipantLlmGateway {
  constructor(
    private readonly client: LLMClient,
    private readonly prompts: PromptCatalog = new PromptCatalog()
  ) {}

  async extractBrief(input: BriefInput): Promise<StructuredBrief> {
    const structuredContext = await this.chat([
      { role: "system", content: this.slotExtractPrompt(input.side) },
      { role: "user", content: input.rawInputs.join("\n") },
    ]);

    const summary = this.sanitizeSummary(
      await this.chat([
        { role: "system", content: this.briefPrompt(input.side) },
        { role: "user", content: structuredContext },
      ]),
      structuredContext,
      { side: input.side }
    );

    return { structuredContext, summary };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    const structuredContext = this.withLatestRevisionSection(
      await this.chat([
        { role: "system", content: this.appendPrompt(input.side) },
        {
          role: "user",
          content:
            `【現在の分析】\n${input.currentStructuredContext}\n\n` +
            `【依頼人の訂正・追加発言（現在の分析より優先）】\n${input.additionalInput}`,
        },
      ]),
      input.additionalInput
    );

    const initialSummary = this.sanitizeSummary(
      await this.chat([
        { role: "system", content: this.briefPrompt(input.side) },
        { role: "user", content: structuredContext },
      ]),
      structuredContext,
      { ensureLatestRevision: false, side: input.side }
    );
    const summary = await this.rethinkSummaryIfLatestRevisionMissing(
      initialSummary,
      structuredContext,
      input.side
    );

    return { structuredContext, summary };
  }

  async generateProbe(input: ProbeInput): Promise<string> {
    const probe = await this.chat([
      { role: "system", content: this.probePrompt(input.side) },
      { role: "user", content: `依頼人の情報:\n${input.structuredContext}` },
    ]);

    return this.sanitizeProbe(probe);
  }

  // ── A/B プロンプト解決ヘルパ ─────────────
  private slotExtractPrompt(side: ParticipantSide): string {
    return side === "A" ? this.prompts.slotExtractA() : this.prompts.slotExtractB();
  }
  private briefPrompt(side: ParticipantSide): string {
    return side === "A" ? this.prompts.briefA() : this.prompts.briefB();
  }
  private appendPrompt(side: ParticipantSide): string {
    return side === "A" ? this.prompts.appendA() : this.prompts.appendB();
  }
  private probePrompt(side: ParticipantSide): string {
    return side === "A" ? this.prompts.probeA() : this.prompts.probeB();
  }
  private revisionReflectionPrompt(side: ParticipantSide): string {
    return side === "A"
      ? this.prompts.revisionReflectionA()
      : this.prompts.revisionReflectionB();
  }
  private consolationPrompt(
    side: ParticipantSide,
    loserContext: string,
    judgmentHistory: string
  ): string {
    return side === "A"
      ? this.prompts.consolationA(loserContext, judgmentHistory)
      : this.prompts.consolationB(loserContext, judgmentHistory);
  }

  async generateConsolation(input: ConsolationInput): Promise<string> {
    return this.chat([
      {
        role: "system",
        content: this.consolationPrompt(
          input.side,
          input.loserContext,
          input.judgmentHistory.join("\n")
        ),
      },
      { role: "user", content: "最後のメッセージを送ってほしい。" },
    ]);
  }

  private async chat(messages: LLMMessage[]): Promise<string> {
    const response = await this.client.chat(messages);
    return response.content;
  }

  private sanitizeProbe(content: string): string {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(PROBE_LINE_PREFIX, "").trim())
      .filter(Boolean);

    for (const line of lines) {
      const firstQuestion = this.takeFirstQuestionSentence(line);
      if (firstQuestion) {
        return firstQuestion;
      }

      const firstSentence = this.takeFirstSentence(line);
      if (firstSentence) {
        return firstSentence;
      }
    }

    return "一番引っかかってるポイントだけ具体的に教えて。";
  }

  private sanitizeSummary(
    content: string,
    structuredContext: string,
    options: { ensureLatestRevision?: boolean; side?: ParticipantSide } = {}
  ): string {
    if (this.isBannedSummaryContent(content)) {
      return this.buildFallbackSummary(structuredContext);
    }

    const cleanedLines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !this.isBannedSummaryLine(line));

    if (cleanedLines.length === 0) {
      return this.buildFallbackSummary(structuredContext);
    }

    const summary = cleanedLines.join("\n\n");
    if (options.ensureLatestRevision === false) {
      return summary;
    }

    return this.ensureLatestRevisionReflected(summary, structuredContext);
  }

  private isBannedSummaryContent(content: string): boolean {
    return SUMMARY_BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
  }

  private isBannedSummaryLine(line: string): boolean {
    if (SUMMARY_BANNED_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      return true;
    }

    return QUESTION_END_PATTERN.test(line);
  }

  private takeFirstQuestionSentence(line: string): string | null {
    const match = line.match(/^(.+?[？?])/);
    if (!match) {
      return null;
    }

    return this.normalizeSentence(match[1]);
  }

  private takeFirstSentence(line: string): string | null {
    const match = line.match(/^(.+?[。.!！]|.+$)/);
    if (!match) {
      return null;
    }

    return this.normalizeSentence(match[1]);
  }

  private normalizeSentence(text: string): string {
    return text.replace(MULTI_SPACE_PATTERN, " ").trim();
  }

  private ensureLatestRevisionReflected(
    summary: string,
    structuredContext: string
  ): string {
    const latestRevision = this.parseStructuredSections(structuredContext)[
      LATEST_REVISION_SECTION
    ];
    if (!latestRevision || this.isRevisionReflected(summary, latestRevision)) {
      return summary;
    }

    return `最新の訂正では「${latestRevision}」が正しい。\n\n${summary}`;
  }

  private async rethinkSummaryIfLatestRevisionMissing(
    summary: string,
    structuredContext: string,
    side: ParticipantSide
  ): Promise<string> {
    const latestRevision = this.parseStructuredSections(structuredContext)[
      LATEST_REVISION_SECTION
    ];
    if (!latestRevision || this.isRevisionReflected(summary, latestRevision)) {
      return summary;
    }

    const revisedSummary = this.sanitizeSummary(
      await this.chat([
        { role: "system", content: this.revisionReflectionPrompt(side) },
        {
          role: "user",
          content:
            `【構造化ブリーフ】\n${structuredContext}\n\n` +
            `【直近修正】\n${latestRevision}\n\n` +
            `【前回確認文】\n${summary}`,
        },
      ]),
      structuredContext,
      { ensureLatestRevision: false, side }
    );

    return this.ensureLatestRevisionReflected(revisedSummary, structuredContext);
  }

  private isRevisionReflected(summary: string, latestRevision: string): boolean {
    return this.includesNormalized(summary, latestRevision);
  }

  private includesNormalized(text: string, search: string): boolean {
    const normalize = (value: string) =>
      value.replace(/[。\s「」『』、,.!?！？]/g, "");

    return normalize(text).includes(normalize(search));
  }

  private buildFallbackSummary(structuredContext: string): string {
    const sections = this.parseStructuredSections(structuredContext);
    const understanding = sections["案件の理解"] || "状況の整理がまだ足りてない。";
    const latestRevision = sections[LATEST_REVISION_SECTION];
    const interest = sections["インタレスト"];
    const weapon = sections["武器"];

    const parts = [understanding];
    if (latestRevision) {
      parts.unshift(`最新の訂正では「${latestRevision}」が正しい。`);
    }
    if (interest && interest !== "不明") {
      parts.push(`お前が大事にしてるのは${interest}ってことだよな。`);
    }
    if (weapon && weapon !== "不明") {
      parts.push(`今の武器として見えてるのは、${weapon}って点だ。`);
    }

    return parts.join("\n\n");
  }

  private withLatestRevisionSection(
    structuredContext: string,
    latestInput: string
  ): string {
    const cleaned = structuredContext
      .replace(LATEST_REVISION_SECTION_PATTERN, "")
      .trim();

    return `${cleaned}\n\n■${LATEST_REVISION_SECTION}:\n${latestInput.trim()}`;
  }

  private parseStructuredSections(structuredContext: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const matches = structuredContext.matchAll(STRUCTURED_SECTION_PATTERN);

    for (const match of matches) {
      const title = match[1]?.trim();
      const body = match[2]?.trim();
      if (!title || !body) {
        continue;
      }

      sections[title] = body.replace(MULTI_SPACE_PATTERN, " ").trim();
    }

    return sections;
  }

}
