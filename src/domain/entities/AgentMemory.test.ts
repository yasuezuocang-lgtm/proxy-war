import test from "node:test";
import assert from "node:assert/strict";
import { AgentMemory } from "./AgentMemory.js";
import {
  asOwnBrief,
  type OwnBrief,
} from "../../application/ports/ParticipantAgent.js";

// Step 5 / migration-plan §3 Step 5:
// AgentMemory<Side> は A/B の代理人記憶を Side ジェネリックで型隔離する集約。
// architecture.md §4.2 と requirements.md F-30〜F-33 の意思を型で固定する。
//
// 7 + 3 フィールド:
//   spec       : side / principalId / privateBrief / privateGoal / publicGoal /
//                strategyNotes / hearingHistory
//   operation  : rawInputs / briefSummary / confirmedAt
//                （既存 Brief から移譲する受け皿。SubmitInput / ConfirmBrief が触る）

test('AgentMemory<"A"> は side と principalId を readonly に保持する', () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });

  assert.equal(memory.side, "A");
  assert.equal(memory.principalId, "user-A");
});

test('AgentMemory<"B"> は side="B" のリテラル型として推論される', () => {
  const memory = new AgentMemory<"B">({
    side: "B",
    principalId: "user-B",
  });

  // 型レベル: side は "B" リテラルに narrow される（"A" には代入できない）。
  const side: "B" = memory.side;
  assert.equal(side, "B");
});

test("初期状態では privateBrief は空文字、ゴール/サマリ/confirmedAt は null、配列は空", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });

  assert.equal(
    memory.privateBrief,
    "",
    "privateBrief は OwnBrief<Side> string ブランドの空文字で初期化"
  );
  assert.equal(memory.privateGoal, null, "私的ゴールは未設定（F-32）");
  assert.equal(memory.publicGoal, null, "公開ゴールは未設定（F-30 / F-33）");
  assert.equal(memory.briefSummary, null, "要約は未生成");
  assert.equal(memory.confirmedAt, null, "確定タイムスタンプは未設定");
  assert.deepEqual(memory.rawInputs, [], "生入力は空配列");
  assert.deepEqual(memory.strategyNotes, [], "戦術ノートは空配列");
  assert.deepEqual(memory.hearingHistory, [], "ヒアリング履歴は空配列");
});

test('privateBrief は OwnBrief<"A"> 型として静的解決され、相互代入できる', () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });
  memory.privateBrief = asOwnBrief("A", "Aの本音整理");

  // 型レベルで OwnBrief<"A"> として narrow される（DoD 完了条件 #2）。
  const brief: OwnBrief<"A"> = memory.privateBrief;
  assert.equal(brief, "Aの本音整理");
});

test('privateBrief は OwnBrief<"B"> 型として静的解決される', () => {
  const memory = new AgentMemory<"B">({
    side: "B",
    principalId: "user-B",
  });
  memory.privateBrief = asOwnBrief("B", "Bの本音整理");

  const brief: OwnBrief<"B"> = memory.privateBrief;
  assert.equal(brief, "Bの本音整理");
});

test("publicGoal と privateGoal は独立フィールドとして共存できる（F-30 / F-32）", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });
  memory.publicGoal = "謝ってほしい";
  memory.privateGoal = "本音は距離を置きたい";

  assert.equal(memory.publicGoal, "謝ってほしい");
  assert.equal(memory.privateGoal, "本音は距離を置きたい");

  // 双方は独立して null/値を保持できる。
  memory.privateGoal = null;
  assert.equal(memory.publicGoal, "謝ってほしい");
  assert.equal(memory.privateGoal, null);

  memory.publicGoal = null;
  memory.privateGoal = "別のゴール";
  assert.equal(memory.publicGoal, null);
  assert.equal(memory.privateGoal, "別のゴール");
});

test("strategyNotes は構造化ノートを蓄積できる（StrategyNote = addedAt / content / source）", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });

  memory.strategyNotes.push({
    addedAt: 1_700_000_000_000,
    content: "Bは事実を曖昧にしている",
    source: "external",
  });
  memory.strategyNotes.push({
    addedAt: 1_700_000_001_000,
    content: "【Q】いつから？ → 【A】3ヶ月前",
    source: "hearing_answer",
  });

  assert.equal(memory.strategyNotes.length, 2);
  assert.equal(memory.strategyNotes[0]?.source, "external");
  assert.equal(memory.strategyNotes[1]?.source, "hearing_answer");
  assert.match(memory.strategyNotes[1]?.content ?? "", /3ヶ月前/);
});

test("hearingHistory は HearingExchange エントリを蓄積できる", () => {
  const memory = new AgentMemory<"B">({
    side: "B",
    principalId: "user-B",
  });

  memory.hearingHistory.push({
    askedAt: 1_700_000_000_000,
    question: "いつから？",
    reason: "時系列特定",
    answer: null,
    answeredAt: null,
  });
  memory.hearingHistory.push({
    askedAt: 1_700_000_001_000,
    question: "誰が同席してた？",
    reason: "裏取り",
    answer: "山田と佐藤",
    answeredAt: 1_700_000_002_000,
  });

  assert.equal(memory.hearingHistory.length, 2);
  assert.equal(memory.hearingHistory[0]?.answer, null, "未回答エントリは answer=null");
  assert.equal(
    memory.hearingHistory[1]?.answer,
    "山田と佐藤",
    "回答済みエントリは answer/answeredAt が埋まる"
  );
});

test("rawInputs / briefSummary / confirmedAt は運用フィールドとして更新できる", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });

  memory.rawInputs.push("最初の本音");
  memory.rawInputs.push("追加の本音");
  memory.briefSummary = "あなたは家事の偏りに不満を抱えている";
  memory.confirmedAt = 1_700_000_000_000;

  assert.deepEqual(memory.rawInputs, ["最初の本音", "追加の本音"]);
  assert.equal(memory.briefSummary, "あなたは家事の偏りに不満を抱えている");
  assert.equal(memory.confirmedAt, 1_700_000_000_000);
});

test("constructor で privateBrief / publicGoal / privateGoal の初期値を渡せる", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
    privateBrief: asOwnBrief("A", "事前の整理"),
    publicGoal: "謝罪",
    privateGoal: "本心では距離を置く",
  });

  assert.equal(memory.privateBrief, "事前の整理");
  assert.equal(memory.publicGoal, "謝罪");
  assert.equal(memory.privateGoal, "本心では距離を置く");
});

test('AgentMemory<"A"> と AgentMemory<"B"> はそれぞれ別 Side リテラル型を持つ', () => {
  const memoryA = new AgentMemory<"A">({ side: "A", principalId: "ua" });
  const memoryB = new AgentMemory<"B">({ side: "B", principalId: "ub" });

  // それぞれ "A" / "B" リテラルとして narrow される。
  const sideA: "A" = memoryA.side;
  const sideB: "B" = memoryB.side;

  assert.equal(sideA, "A");
  assert.equal(sideB, "B");
  assert.notEqual(memoryA.side, memoryB.side);
});

test("AgentMemory は spec 7 + 運用 3 = 10 フィールドを公開する", () => {
  const memory = new AgentMemory<"A">({
    side: "A",
    principalId: "user-A",
  });

  // spec フィールド (architecture.md §4.2 / migration-plan §3 Step 5)
  assert.ok("side" in memory);
  assert.ok("principalId" in memory);
  assert.ok("privateBrief" in memory);
  assert.ok("privateGoal" in memory);
  assert.ok("publicGoal" in memory);
  assert.ok("strategyNotes" in memory);
  assert.ok("hearingHistory" in memory);

  // 運用フィールド (Brief 移譲先)
  assert.ok("rawInputs" in memory);
  assert.ok("briefSummary" in memory);
  assert.ok("confirmedAt" in memory);
});
