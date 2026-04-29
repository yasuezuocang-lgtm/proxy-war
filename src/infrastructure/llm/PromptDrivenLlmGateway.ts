import type { Judgment } from "../../domain/entities/Judgment.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  JudgeRoundInput,
  LlmGateway,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
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

export class PromptDrivenLlmGateway implements LlmGateway {
  constructor(
    private readonly client: LLMClient,
    private readonly prompts: PromptCatalog = new PromptCatalog()
  ) {}

  async extractBrief(input: BriefInput): Promise<StructuredBrief> {
    const structuredContext = await this.chat([
      { role: "system", content: this.prompts.slotExtract() },
      { role: "user", content: input.rawInputs.join("\n") },
    ]);

    const summary = this.sanitizeSummary(
      await this.chat([
        { role: "system", content: this.prompts.brief() },
        { role: "user", content: structuredContext },
      ]),
      structuredContext
    );

    return { structuredContext, summary };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    const structuredContext = this.withLatestRevisionSection(
      await this.chat([
        { role: "system", content: this.prompts.append() },
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
        { role: "system", content: this.prompts.brief() },
        { role: "user", content: structuredContext },
      ]),
      structuredContext,
      { ensureLatestRevision: false }
    );
    const summary = await this.rethinkSummaryIfLatestRevisionMissing(
      initialSummary,
      structuredContext
    );

    return { structuredContext, summary };
  }

  async generateProbe(structuredContext: string): Promise<string> {
    const probe = await this.chat([
      { role: "system", content: this.prompts.probe() },
      { role: "user", content: `依頼人の情報:\n${structuredContext}` },
    ]);

    return this.sanitizeProbe(probe);
  }

  async judgeRound(input: JudgeRoundInput): Promise<Judgment> {
    const response = await this.chat([
      { role: "system", content: this.prompts.judge(input.courtLevel) },
      {
        role: "user",
        content: this.buildJudgeUserPrompt(input),
      },
    ]);

    return this.parseJudgment(response);
  }

  private buildJudgeUserPrompt(input: JudgeRoundInput): string {
    const parts: string[] = [];

    parts.push(
      `## 議論のゴール\nA側のゴール: ${input.goalA || "未設定"}\nB側のゴール: ${input.goalB || "未設定"}`
    );
    parts.push(`## A側の背景\n${input.contextA}`);
    parts.push(`## B側の背景\n${input.contextB}`);
    parts.push(
      `## 第一審 議論の全文\n${input.dialogue
        .map((turn) => `${turn.speaker}側: ${turn.message}`)
        .join("\n\n")}`
    );

    if (input.previousJudgments.length > 0) {
      parts.push(
        `## 過去の審理記録\n${input.previousJudgments
          .map((judgment, index) => this.formatPreviousJudgment(judgment, index))
          .join("\n\n")}`
      );
    }

    if (input.appeal) {
      parts.push(
        `## ${input.appeal.appellantSide}側からの異議\n${input.appeal.content}`
      );
    }

    return parts.join("\n\n");
  }

  private formatPreviousJudgment(judgment: Judgment, index: number): string {
    const label = index === 0 ? "第一審" : index === 1 ? "再審（高裁）" : `第${index + 1}審`;
    const winner = judgment.winner === "draw" ? "引き分け" : `${judgment.winner}側`;
    return (
      `### ${label}\n` +
      `勝者: ${winner}\n` +
      `スコア A:${judgment.totalA} / B:${judgment.totalB}\n` +
      `総評: ${judgment.summary}`
    );
  }

  async generateConsolation(input: ConsolationInput): Promise<string> {
    return this.chat([
      {
        role: "system",
        content: this.prompts.consolation(
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
    options: { ensureLatestRevision?: boolean } = {}
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
    structuredContext: string
  ): Promise<string> {
    const latestRevision = this.parseStructuredSections(structuredContext)[
      LATEST_REVISION_SECTION
    ];
    if (!latestRevision || this.isRevisionReflected(summary, latestRevision)) {
      return summary;
    }

    const revisedSummary = this.sanitizeSummary(
      await this.chat([
        { role: "system", content: this.prompts.revisionReflection() },
        {
          role: "user",
          content:
            `【構造化ブリーフ】\n${structuredContext}\n\n` +
            `【直近修正】\n${latestRevision}\n\n` +
            `【前回確認文】\n${summary}`,
        },
      ]),
      structuredContext,
      { ensureLatestRevision: false }
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

  private parseJudgment(content: string): Judgment {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let parsed: Partial<Judgment> = {};
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]) as Partial<Judgment>;
      } catch {
        parsed = {};
      }
    }

    // criteria を正規化: 各項目の scoreA/scoreB を 0-5 の整数に丸め、
    // name/reason を文字列として保障する。
    const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
    const criteria = rawCriteria.slice(0, 5).map((raw, index) => ({
      name: typeof raw?.name === "string" ? raw.name : `項目${index + 1}`,
      scoreA: this.coerceScore(raw?.scoreA),
      scoreB: this.coerceScore(raw?.scoreB),
      reason: typeof raw?.reason === "string" ? raw.reason : "",
    }));

    // 合計は criteria から導出する。LLM の totalA/totalB は
    // スコアと自己矛盾している事が多い（例: scoreA=5,scoreB=5 を並べつつ totalA=12,totalB=18）。
    const totalA = criteria.reduce((sum, c) => sum + c.scoreA, 0);
    const totalB = criteria.reduce((sum, c) => sum + c.scoreB, 0);

    // winner も数値合計から導出する。reason で「A の敗北」と書きつつ winner="A"
    // のような矛盾を、機械的に修正する。
    // criteria が無い場合のみ、LLM の winner を fallback として使う。
    const computedWinner: Judgment["winner"] =
      criteria.length === 0
        ? this.validateWinner(parsed.winner)
        : totalA > totalB
          ? "A"
          : totalA < totalB
            ? "B"
            : "draw";

    return {
      winner: computedWinner,
      criteria,
      totalA,
      totalB,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary
          : "判定結果の解釈に失敗した。異議があれば送って再審に回す。",
      zopa: typeof parsed.zopa === "string" ? parsed.zopa : null,
      wisdom: typeof parsed.wisdom === "string" ? parsed.wisdom : null,
      angerA: typeof parsed.angerA === "string" ? parsed.angerA : null,
      angerB: typeof parsed.angerB === "string" ? parsed.angerB : null,
    };
  }

  private validateWinner(value: unknown): Judgment["winner"] {
    if (value === "A" || value === "B" || value === "draw") {
      return value;
    }
    return "draw";
  }

  private coerceScore(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(5, Math.round(n)));
  }
}
