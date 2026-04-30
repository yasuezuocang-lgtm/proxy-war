import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentContext,
  type AgentContext,
  type AgentPersonality,
  type HearingExchange,
  type StrategyNote,
} from "./AgentContext.js";

const personality: AgentPersonality = {
  id: "a-default",
  label: "A代理",
  promptSeed: "依頼人Aの代弁者として冷静に主張する。",
  styleNotes: "敬体・短文。",
};

test("createAgentContext returns an empty context with the given side and personality", () => {
  const ctx = createAgentContext({ side: "A", personality });

  assert.equal(ctx.side, "A");
  assert.equal(ctx.privateBrief, "");
  assert.deepEqual(ctx.strategyNotes, []);
  assert.deepEqual(ctx.hearingHistory, []);
  assert.equal(ctx.personality, personality);
  assert.equal(ctx.turnCount, 0);
});

test("createAgentContext accepts an initial privateBrief", () => {
  const ctx = createAgentContext({
    side: "B",
    personality,
    privateBrief: "友人と喧嘩した。仲直りしたい。",
  });

  assert.equal(ctx.side, "B");
  assert.equal(ctx.privateBrief, "友人と喧嘩した。仲直りしたい。");
});

test("StrategyNote / HearingExchange / AgentContext の型が期待の形になっている", () => {
  const note: StrategyNote = {
    addedAt: 1,
    content: "相手はゴールを曖昧にしている。",
    source: "hearing_answer",
  };

  const hearing: HearingExchange = {
    askedAt: 2,
    question: "いつ頃の出来事ですか？",
    reason: "時系列を特定して反論材料にする。",
    answer: null,
    answeredAt: null,
  };

  const ctx: AgentContext = {
    ...createAgentContext({ side: "A", personality }),
    strategyNotes: [note],
    hearingHistory: [hearing],
    privateBrief: "x",
    turnCount: 1,
  };

  assert.equal(ctx.strategyNotes[0]?.source, "hearing_answer");
  assert.equal(ctx.hearingHistory[0]?.answer, null);
  assert.equal(ctx.turnCount, 1);
});
