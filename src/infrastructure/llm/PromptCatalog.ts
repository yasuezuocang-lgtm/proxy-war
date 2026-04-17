import {
  APPEND_PROMPT,
  BATTLE_BRIEF_PROMPT,
  PROBE_PROMPT,
  SLOT_EXTRACT_PROMPT,
  appealSuggestionPrompt,
  judgePrompt,
  proxyBotPrompt,
  type JudgeCourtLevel,
} from "../../llm/prompts.js";

export class PromptCatalog {
  slotExtract(): string {
    return SLOT_EXTRACT_PROMPT;
  }

  append(): string {
    return APPEND_PROMPT;
  }

  probe(): string {
    return PROBE_PROMPT;
  }

  brief(): string {
    return BATTLE_BRIEF_PROMPT;
  }

  proxyBot(side: "A" | "B", ownContext: string): string {
    return proxyBotPrompt(side, ownContext, "fight");
  }

  judge(courtLevel: JudgeCourtLevel = "district"): string {
    return judgePrompt("fight", courtLevel);
  }

  appealSuggestion(
    side: "A" | "B",
    ownBrief: string,
    goal: string | null,
    nextCourtLabel: string
  ): string {
    return appealSuggestionPrompt(side, ownBrief, goal, nextCourtLabel);
  }

  consolation(loserContext: string, judgmentHistory: string): string {
    return `お前は代理戦争の担当者。複数回戦って負けた依頼人に最後のメッセージを送る。

【負けた側の背景】
${loserContext}

【審判の記録】
${judgmentHistory}

【書き方】
- タメ口。AIっぽい丁寧語禁止
- 「お前の怒りは本物だった」ことを最初に認めろ
- 同じ結果が続いた事実は責めずに淡々と伝えろ
- 「この経験をどう活かすか」を1つだけ具体的に渡せ
- 空虚な励ましは禁止
- 150-200字`;
  }
}
