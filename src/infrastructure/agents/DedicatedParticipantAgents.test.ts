import test from "node:test";
import assert from "node:assert/strict";
import { AAgent } from "./AAgent.js";
import { BAgent } from "./BAgent.js";
import type { LLMClient, LLMMessage, LLMResponse } from "../../llm/provider.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  JudgeRoundInput,
  LlmGateway,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
import { asOwnBrief } from "../../application/ports/ParticipantAgent.js";
import type { Judgment } from "../../domain/entities/Judgment.js";

class QueueLlmClient implements LLMClient {
  readonly messages: LLMMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    this.messages.push(messages);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("LLMレスポンスが不足しています。");
    }

    return { content };
  }
}

class FakeLlmGateway implements LlmGateway {
  readonly appendInputs: AppendBriefInput[] = [];

  async extractBrief(_input: BriefInput): Promise<StructuredBrief> {
    return { structuredContext: "", summary: "" };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    this.appendInputs.push(input);
    return {
      structuredContext: `${input.currentStructuredContext}\n${input.additionalInput}`,
      summary: input.additionalInput,
    };
  }

  async generateProbe(): Promise<string> {
    return "追加質問";
  }

  async judgeRound(_input: JudgeRoundInput): Promise<Judgment> {
    return {
      winner: "draw",
      criteria: [],
      totalA: 0,
      totalB: 0,
      summary: "",
      zopa: null,
      wisdom: null,
      angerA: null,
      angerB: null,
    };
  }

  async generateConsolation(_input: ConsolationInput): Promise<string> {
    return "";
  }
}

test("AAgent は A 側専属の立場で system prompt を組む", async () => {
  const client = new QueueLlmClient(["Aの反論"]);
  const gateway = new FakeLlmGateway();
  const agent = new AAgent(client, gateway);

  const result = await agent.generateTurn({
    sessionId: "session-a",
    brief: asOwnBrief("A", "Aの事情"),
    goal: "謝ってほしい",
    conversation: [{ speaker: "B", message: "Bの主張" }],
    turnIndex: 1,
  });

  assert.deepEqual(result, { type: "message", message: "Aの反論" });
  const systemPrompt = client.messages[0]?.[0]?.content || "";
  assert.match(systemPrompt, /A側専属代理人/);
  assert.match(systemPrompt, /勝ち取りたいこと/);
  assert.match(systemPrompt, /Aの事情/);
});

test("BAgent は hearing 回答を自分のセッションメモリへ積む", async () => {
  const client = new QueueLlmClient([
    "[HEARING:その時どう返した？]",
    "Bの再反論",
  ]);
  const gateway = new FakeLlmGateway();
  const agent = new BAgent(client, gateway);

  const hearing = await agent.generateTurn({
    sessionId: "session-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.deepEqual(hearing, {
    type: "hearing",
    question: "その時どう返した？",
  });

  await agent.absorbHearingAnswer({
    sessionId: "session-b",
    currentStructuredContext: asOwnBrief("B", "元の整理"),
    answer: "その場では黙った",
  });

  await agent.generateTurn({
    sessionId: "session-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [{ speaker: "A", message: "Aの主張" }],
    turnIndex: 1,
  });

  assert.deepEqual(gateway.appendInputs, [
    {
      currentStructuredContext: "元の整理",
      additionalInput: "その場では黙った",
    },
  ]);
  assert.match(
    client.messages[1]?.[0]?.content || "",
    /依頼人に追加で聞いたこと[\s\S]*その場では黙った/
  );
});

test("suggestAppealPoints は自側 brief だけで異議材料を生成する", async () => {
  const client = new QueueLlmClient([
    "- 前審は相手の主張を過大評価した\n- 第二ターンで提示した事実が反映されていない",
  ]);
  const gateway = new FakeLlmGateway();
  const agent = new AAgent(client, gateway);

  const result = await agent.suggestAppealPoints({
    sessionId: "session-appeal",
    brief: asOwnBrief("A", "Aだけが知ってる固有トークン:ALPHA_ONLY"),
    goal: "尊重してほしい",
    dialogue: [
      { speaker: "A", message: "Aの発言" },
      { speaker: "B", message: "Bの発言（公開）" },
    ],
    judgment: {
      winner: "B",
      criteria: [
        { name: "論理", scoreA: 2, scoreB: 4, reason: "Bが一貫" },
      ],
      totalA: 2,
      totalB: 4,
      summary: "B優勢",
      zopa: null,
      wisdom: null,
      angerA: null,
      angerB: null,
    },
    nextCourtLevel: "high",
  });

  assert.match(result, /前審は相手の主張を過大評価した/);

  const systemPrompt = client.messages[0]?.[0]?.content || "";
  assert.match(systemPrompt, /ALPHA_ONLY/, "A の brief が prompt に入っている");
  assert.match(systemPrompt, /高等裁判所/, "次審のラベルが入っている");
});
