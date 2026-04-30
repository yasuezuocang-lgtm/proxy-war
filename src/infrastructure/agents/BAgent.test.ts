import test from "node:test";
import assert from "node:assert/strict";
import { BAgent } from "./BAgent.js";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
} from "../../llm/provider.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  JudgeRoundInput,
  LlmGateway,
  StructuredBrief,
} from "../../application/ports/LlmGateway.js";
import {
  asOwnBrief,
  type ParticipantAgent,
} from "../../application/ports/ParticipantAgent.js";
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

test("BAgent は新 ParticipantAgent<'B'> インターフェースを満たす", () => {
  const agent: ParticipantAgent<"B"> = new BAgent(
    new QueueLlmClient([]),
    new FakeLlmGateway()
  );
  assert.equal(agent.side, "B");
  assert.equal(agent.personality.id, "b-agent-v1");
  assert.equal(agent.personality.label, "B代理人");
  assert.equal(typeof agent.generateOpeningTurn, "function");
  assert.equal(typeof agent.generateReplyTurn, "function");
  assert.equal(typeof agent.absorbHearingAnswer, "function");
  assert.equal(typeof agent.getStrategyMemo, "function");
});

test("generateOpeningTurn は B 専用の system prompt と opening 指示で発言を返す", async () => {
  const llm = new QueueLlmClient(["Bの切り出し"]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "opening-b",
    brief: asOwnBrief("B", "Bの事情トークン:BETA"),
    goal: "歩み寄ってほしい",
    conversation: [],
    turnIndex: 0,
  });

  assert.deepEqual(result, { type: "message", message: "Bの切り出し" });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(system, /B側専属代理人/, "B 専用の立場指示が含まれる");
  assert.match(system, /Bの事情トークン:BETA/, "B の brief が含まれる");
  assert.match(system, /勝ち取りたいこと/, "ゴール節が含まれる");
  assert.doesNotMatch(
    system,
    /A側専属代理人/,
    "A 側の立場指示が紛れ込んでいない"
  );

  const instruction = llm.messages[0]?.at(-1)?.content || "";
  assert.match(instruction, /争点|芯/, "turnIndex=0 は opening 指示");
});

test("generateReplyTurn は A の直前発言を user ロールで渡し reply 指示を出す", async () => {
  const llm = new QueueLlmClient(["Bの打ち返し"]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateReplyTurn({
    sessionId: "reply-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [{ speaker: "A", message: "Aの主張" }],
    turnIndex: 1,
  });

  assert.deepEqual(result, { type: "message", message: "Bの打ち返し" });

  const sent = llm.messages[0] || [];
  const aTurn = sent.find(
    (m) => m.role === "user" && m.content === "Aの主張"
  );
  assert.ok(aTurn, "A の発言は user ロールで渡る");

  const instruction = sent.at(-1)?.content || "";
  assert.match(instruction, /打ち返せ|引っ掛かる/, "reply の指示");
});

test("HEARING 応答は reason を必須化した新 AgentTurnResult として返る", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:Aが出したって言ってる通知、いつ受け取った？|武器リストにない事実が必要]",
  ]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "hearing-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(
    result.question,
    "Aが出したって言ってる通知、いつ受け取った？"
  );
  assert.match(
    result.reason,
    /武器|反論/,
    "reason が埋まる"
  );
});

test("reason 省略の [HEARING:Q] でも reason を安全に補完する", async () => {
  const llm = new QueueLlmClient(["[HEARING:何月何日の話？]"]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "hearing-b-fallback",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(result.question, "何月何日の話？");
  assert.ok(
    result.reason.length > 0,
    "reason は空にせずデフォルト文言で埋める"
  );
});

test("absorbHearingAnswer は B 側の武器リストへ積み、次ターンの system prompt に現れる", async () => {
  const llm = new QueueLlmClient(["Bの次ターン"]);
  const gateway = new FakeLlmGateway();
  const agent = new BAgent(llm, gateway);

  await agent.absorbHearingAnswer({
    sessionId: "absorb-b",
    currentStructuredContext: asOwnBrief("B", "元の整理"),
    answer: "3月の飲み会の時にその話をされた",
  });

  assert.deepEqual(gateway.appendInputs, [
    {
      side: "B",
      currentStructuredContext: "元の整理",
      additionalInput: "3月の飲み会の時にその話をされた",
    },
  ]);

  await agent.generateReplyTurn({
    sessionId: "absorb-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [{ speaker: "A", message: "Aの主張" }],
    turnIndex: 1,
  });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(
    system,
    /武器リスト[\s\S]*3月の飲み会の時にその話をされた/,
    "ヒアリング回答が武器リストとして次ターンに反映される"
  );
});

test("getStrategyMemo はヒアリング回答を戦術メモとして返す", async () => {
  const agent = new BAgent(new QueueLlmClient([]), new FakeLlmGateway());

  assert.equal(agent.getStrategyMemo(), "", "初期状態は空");

  await agent.absorbHearingAnswer({
    sessionId: "memo-b",
    currentStructuredContext: asOwnBrief("B", "元"),
    answer: "半年前から同じ提案をしている",
  });

  assert.match(agent.getStrategyMemo(), /半年前から同じ提案をしている/);
});

test("武器リストが埋まっている時は LLM が HEARING を返しても message に抑止する", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:Aが言う通知、いつ送ったって言ってる？|事実を確かめたい]",
  ]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  // 武器リストを先に1件積む
  await agent.absorbHearingAnswer({
    sessionId: "h4-b",
    currentStructuredContext: asOwnBrief("B", "元"),
    answer: "Aから通知が来たのは3月15日",
  });

  const result = await agent.generateReplyTurn({
    sessionId: "h4-b",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [{ speaker: "A", message: "Aの発言" }],
    turnIndex: 1,
  });

  assert.equal(
    result.type,
    "message",
    "武器が揃っている状況では HEARING は抑止される"
  );
  if (result.type !== "message") return;
  assert.match(
    result.message,
    /いつ送ったって言ってる/,
    "抑止時は HEARING の質問本文を message に再利用する"
  );

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(
    system,
    /絶対禁止条件|絶対に出すな/,
    "system prompt に H4 の禁止制約が含まれる"
  );
});

test("抽象的な HEARING は一度だけ書き直しを試みる", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:もう少し状況を聞かせて|武器が足りない]",
    "[HEARING:Aが通知出したのはいつ？|事実確認のため]",
  ]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "h1-b-retry",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(
    result.question,
    "Aが通知出したのはいつ？",
    "再生成後の具体的な質問が採用される"
  );
  assert.equal(llm.messages.length, 2, "抽象検出で LLM が2回呼ばれる");

  const retryPrompt = llm.messages[1].at(-1)?.content || "";
  assert.match(
    retryPrompt,
    /抽象的/,
    "再生成時に抽象禁止の追加指示が渡る"
  );
});

test("具体的な HEARING は再生成しない", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:飲み会で誰が同じ話を聞いてた？|裏取り]",
  ]);
  const agent = new BAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "h1-b-skip",
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  assert.equal(llm.messages.length, 1, "具体質問なら再生成されない");
});

test("直前の HEARING 質問と回答が戦術メモに構造化追記され、次ターンの system prompt で明示参照される", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:Aが通知出したのはいつ？|事実確認]",
    "Bの次ターン",
  ]);
  const agent = new BAgent(llm, new FakeLlmGateway());
  const sessionId = "h3-b-structured";

  // 1 ターン目: HEARING を出して、B 側エージェントは質問を内部キャッシュする。
  const hearingTurn = await agent.generateOpeningTurn({
    sessionId,
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });
  assert.equal(hearingTurn.type, "hearing");

  // 回答を absorb すると、memo には Q→A のペアで積まれる。
  await agent.absorbHearingAnswer({
    sessionId,
    currentStructuredContext: asOwnBrief("B", "元"),
    answer: "3月15日にLINEで来た",
  });

  const memo = agent.getStrategyMemo();
  assert.match(
    memo,
    /Aが通知出したのはいつ[\s\S]*3月15日にLINEで来た/,
    "戦術メモは Q+A の構造化エントリとして積まれる"
  );
  assert.match(memo, /【Q】/, "質問ラベルが memo に含まれる");
  assert.match(memo, /【A】/, "回答ラベルが memo に含まれる");

  // 2 ターン目: system prompt の「B代理の戦術メモ」に Q+A が現れる。
  await agent.generateReplyTurn({
    sessionId,
    brief: asOwnBrief("B", "Bの事情"),
    goal: null,
    conversation: [{ speaker: "A", message: "Aの主張" }],
    turnIndex: 1,
  });
  const nextSystem = llm.messages[1]?.[0]?.content || "";
  assert.match(
    nextSystem,
    /B代理の戦術メモ[\s\S]*Aが通知出したのはいつ[\s\S]*3月15日にLINEで来た/,
    "次ターンの system prompt で戦術メモが明示参照される"
  );
});

test("resetSession で B のセッション状態が初期化される", async () => {
  const agent = new BAgent(new QueueLlmClient([]), new FakeLlmGateway());

  await agent.absorbHearingAnswer({
    sessionId: "reset-b",
    currentStructuredContext: asOwnBrief("B", "元"),
    answer: "覚えておくべき回答",
  });
  assert.match(agent.getStrategyMemo(), /覚えておくべき回答/);

  agent.resetSession("reset-b");
  assert.equal(agent.getStrategyMemo(), "", "reset 後は memo が空になる");
});
