import test from "node:test";
import assert from "node:assert/strict";
import { AAgent } from "./AAgent.js";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
} from "../../llm/provider.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  LlmGateway,
  StructuredBrief,
  JudgeRoundInput,
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

// 型レベルで AAgent が新 ParticipantAgent<"A">（SPEC §8.2）を満たすことを
// テストファイルでも担保する。実装側で implements を外したらコンパイルが落ちる。
test("AAgent は新 ParticipantAgent<'A'> インターフェースを満たす", () => {
  const agent: ParticipantAgent<"A"> = new AAgent(
    new QueueLlmClient([]),
    new FakeLlmGateway()
  );
  assert.equal(agent.side, "A");
  assert.equal(agent.personality.id, "a-agent-v1");
  assert.equal(agent.personality.label, "A代理人");
  assert.equal(typeof agent.generateOpeningTurn, "function");
  assert.equal(typeof agent.generateReplyTurn, "function");
  assert.equal(typeof agent.absorbHearingAnswer, "function");
  assert.equal(typeof agent.getStrategyMemo, "function");
});

test("generateOpeningTurn は A 専用の system prompt と opening 指示で発言を返す", async () => {
  const llm = new QueueLlmClient(["Aの切り出し"]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "opening-session",
    brief: asOwnBrief("A", "Aの事情トークン:ALPHA"),
    goal: "謝ってほしい",
    conversation: [],
    turnIndex: 0,
  });

  assert.deepEqual(result, { type: "message", message: "Aの切り出し" });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(system, /A側専属代理人/, "A 専用の立場指示が含まれる");
  assert.match(system, /Aの事情トークン:ALPHA/, "A の brief が含まれる");
  assert.match(system, /勝ち取りたいこと/, "ゴール節が含まれる");
  assert.doesNotMatch(
    system,
    /B側専属代理人/,
    "B 側の立場指示が紛れ込んでいない"
  );

  const instruction = llm.messages[0]?.at(-1)?.content || "";
  assert.match(instruction, /切り出せ/, "turnIndex=0 は opening 指示");
});

test("generateReplyTurn は B の直前発言を user ロールで渡し reply 指示を出す", async () => {
  const llm = new QueueLlmClient(["Aの反論"]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateReplyTurn({
    sessionId: "reply-session",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [{ speaker: "B", message: "Bの主張" }],
    turnIndex: 1,
  });

  assert.deepEqual(result, { type: "message", message: "Aの反論" });

  const sent = llm.messages[0] || [];
  const bTurn = sent.find(
    (m) => m.role === "user" && m.content === "Bの主張"
  );
  assert.ok(bTurn, "B の発言は user ロールで渡る");

  const instruction = sent.at(-1)?.content || "";
  assert.match(instruction, /反論|返/, "reply の指示（反論・返答系）");
});

test("HEARING 応答は reason を必須化した新 AgentTurnResult として返る", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:相手が毎日遅刻って言ってるけど、実際どうだった？|反論材料の事実が武器リストにないため]",
  ]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "hearing-session",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(result.question, "相手が毎日遅刻って言ってるけど、実際どうだった？");
  assert.match(
    result.reason,
    /反論材料|武器/,
    "SPEC H5 に従って reason が埋まる"
  );
});

test("reason 省略の [HEARING:Q] でも reason を安全に補完する", async () => {
  const llm = new QueueLlmClient(["[HEARING:いつから？]"]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "hearing-fallback",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(result.question, "いつから？");
  assert.ok(
    result.reason.length > 0,
    "reason は空にせずデフォルト文言で埋める"
  );
});

test("absorbHearingAnswer は A 側の武器リストへ積み、次ターンの system prompt に現れる", async () => {
  const llm = new QueueLlmClient(["Aの次ターン"]);
  const gateway = new FakeLlmGateway();
  const agent = new AAgent(llm, gateway);

  await agent.absorbHearingAnswer({
    sessionId: "absorb-session",
    currentStructuredContext: asOwnBrief("A", "元の整理"),
    answer: "その場では黙ってた",
  });

  assert.deepEqual(gateway.appendInputs, [
    {
      currentStructuredContext: "元の整理",
      additionalInput: "その場では黙ってた",
    },
  ]);

  await agent.generateReplyTurn({
    sessionId: "absorb-session",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [{ speaker: "B", message: "Bの主張" }],
    turnIndex: 1,
  });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(
    system,
    /武器リスト[\s\S]*その場では黙ってた/,
    "ヒアリング回答が武器リストとして次ターンに反映される"
  );
});

test("getStrategyMemo はヒアリング回答を戦術メモとして返す", async () => {
  const agent = new AAgent(new QueueLlmClient([]), new FakeLlmGateway());

  assert.equal(agent.getStrategyMemo(), "", "初期状態は空");

  await agent.absorbHearingAnswer({
    sessionId: "memo-session",
    currentStructuredContext: asOwnBrief("A", "元"),
    answer: "3ヶ月前から遅刻が続いている",
  });

  assert.match(agent.getStrategyMemo(), /3ヶ月前から遅刻が続いている/);
});

test("武器リストが埋まっている時は LLM が HEARING を返しても message に抑止する（P1-8/H4）", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:いつから遅刻が続いてるの？|事実が欲しい]",
  ]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  // 武器リストを先に1件積む
  await agent.absorbHearingAnswer({
    sessionId: "h4-a",
    currentStructuredContext: asOwnBrief("A", "元"),
    answer: "3ヶ月前から遅刻が続いている",
  });

  const result = await agent.generateReplyTurn({
    sessionId: "h4-a",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [{ speaker: "B", message: "Bの発言" }],
    turnIndex: 1,
  });

  assert.equal(
    result.type,
    "message",
    "武器リストが埋まっている状況では HEARING は抑止される"
  );
  if (result.type !== "message") return;
  assert.match(
    result.message,
    /いつから遅刻が続いてるの/,
    "抑止時は HEARING の質問本文を message に再利用する"
  );

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(
    system,
    /絶対禁止条件|絶対に出すな/,
    "system prompt に H4 の禁止制約が含まれる"
  );
});

test("抽象的な HEARING は一度だけ書き直しを試みる（P1-9/H1）", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:状況を教えて|反論材料が足りない]",
    "[HEARING:いつから無視されてた？|事実確認のため]",
  ]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "h1-a-retry",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  if (result.type !== "hearing") return;
  assert.equal(
    result.question,
    "いつから無視されてた？",
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

test("具体的な HEARING は再生成しない（P1-9/H1）", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:3月の面談で何を言われた？|事実確認]",
  ]);
  const agent = new AAgent(llm, new FakeLlmGateway());

  const result = await agent.generateOpeningTurn({
    sessionId: "h1-a-skip",
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });

  assert.equal(result.type, "hearing");
  assert.equal(llm.messages.length, 1, "具体質問なら再生成されない");
});

test("P1-12/H3: 直前の HEARING 質問と回答が戦術メモに構造化追記され、次ターンの system prompt で明示参照される", async () => {
  const llm = new QueueLlmClient([
    "[HEARING:先週の飲み会で誰が同席してた？|裏取り]",
    "Aの次ターン",
  ]);
  const agent = new AAgent(llm, new FakeLlmGateway());
  const sessionId = "h3-a-structured";

  // 1 ターン目: HEARING が出て、A 側エージェントは質問を内部キャッシュする。
  const hearingTurn = await agent.generateOpeningTurn({
    sessionId,
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [],
    turnIndex: 0,
  });
  assert.equal(hearingTurn.type, "hearing");

  // 依頼人から戻ってきた回答を absorb すると、memo には「Q→A」が入る。
  await agent.absorbHearingAnswer({
    sessionId,
    currentStructuredContext: asOwnBrief("A", "元"),
    answer: "山田と佐藤が同席してた",
  });

  const memo = agent.getStrategyMemo();
  assert.match(
    memo,
    /先週の飲み会で誰が同席してた[\s\S]*山田と佐藤が同席してた/,
    "戦術メモは Q+A の構造化エントリとして積まれる"
  );
  assert.match(memo, /【Q】/, "質問ラベルが memo に含まれる");
  assert.match(memo, /【A】/, "回答ラベルが memo に含まれる");

  // 2 ターン目: system prompt の「戦術メモ」セクションに Q+A が現れる。
  await agent.generateReplyTurn({
    sessionId,
    brief: asOwnBrief("A", "Aの事情"),
    goal: null,
    conversation: [{ speaker: "B", message: "Bの主張" }],
    turnIndex: 1,
  });
  const nextSystem = llm.messages[1]?.[0]?.content || "";
  assert.match(
    nextSystem,
    /A代理の戦術メモ[\s\S]*先週の飲み会で誰が同席してた[\s\S]*山田と佐藤が同席してた/,
    "次ターンの system prompt で戦術メモが明示参照される"
  );
});

test("resetSession で A のセッション状態が初期化される", async () => {
  const agent = new AAgent(new QueueLlmClient([]), new FakeLlmGateway());

  await agent.absorbHearingAnswer({
    sessionId: "reset-session",
    currentStructuredContext: asOwnBrief("A", "元"),
    answer: "記憶に残る回答",
  });
  assert.match(agent.getStrategyMemo(), /記憶に残る回答/);

  agent.resetSession("reset-session");
  assert.equal(agent.getStrategyMemo(), "", "reset 後は memo が空になる");
});
