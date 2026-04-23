import type { LLMClient, LLMMessage } from "../../llm/provider.js";
import type { JudgeRoundInput } from "../../application/ports/LlmGateway.js";
import type { Judgment } from "../../domain/entities/Judgment.js";
import type { AgentPersonality } from "../../domain/entities/AgentContext.js";
import {
  JUDGE_AGENT_PERSONALITY,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
} from "./prompts/judge-agent.js";

// 審判エージェント（SPEC §8.2 — "interface JudgeAgent { judgeRound(input): Promise<Judgment>; }"）。
// - A代理人・B代理人とは独立のクラス。コードは共有しない
// - 裁判官らしい丁寧調のプロンプトを使う（SPEC §7.5）
// - 過去判決を入力として受け取り、第一審 / 再審 / 最終審のどの段でも動く
// - このクラスは判定専用。対話ターン生成 / ヒアリング判定は行わない
//
// P1-16 以降で DebateCoordinator から直接呼ばれる想定。現状は
// RefereeLlmGateway 経由の判定と並行して存在する（P1-7 で集約する）。
export class JudgeAgent {
  readonly personality: AgentPersonality = JUDGE_AGENT_PERSONALITY;

  constructor(private readonly llmClient: LLMClient) {}

  async judgeRound(input: JudgeRoundInput): Promise<Judgment> {
    const systemPrompt = buildJudgeSystemPrompt({
      courtLevel: input.courtLevel,
      previousJudgmentCount: input.previousJudgments.length,
    });
    const userPrompt = buildJudgeUserPrompt(input);

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.llmClient.chat(messages);
    return this.parseJudgment(response.content);
  }

  // LLM の JSON を Judgment へ正規化する。
  // - criteria は 5 件まで、scoreA/scoreB は 0-5 の整数へ丸める
  // - totalA/totalB は criteria から再計算（LLM の self-report が自己矛盾することが多いため）
  // - winner は合計から導出（criteria が空なら LLM の winner を fallback で使う）
  // - パース失敗でも "draw" の Judgment を返して呼び出し側が次フェーズへ進めるようにする
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

    const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
    const criteria = rawCriteria.slice(0, 5).map((raw, index) => ({
      name: typeof raw?.name === "string" ? raw.name : `項目${index + 1}`,
      scoreA: this.coerceScore(raw?.scoreA),
      scoreB: this.coerceScore(raw?.scoreB),
      reason: typeof raw?.reason === "string" ? raw.reason : "",
    }));

    const totalA = criteria.reduce((sum, c) => sum + c.scoreA, 0);
    const totalB = criteria.reduce((sum, c) => sum + c.scoreB, 0);

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
          : "判定結果の解釈に失敗しました。異議があれば再審に回します。",
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
