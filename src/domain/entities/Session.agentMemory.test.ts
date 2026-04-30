import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "./Session.js";
import { AgentMemory } from "./AgentMemory.js";
import {
  asOwnBrief,
  type OwnBrief,
} from "../../application/ports/ParticipantAgent.js";

// Step 5 / migration-plan §3 Step 5 / DoD:
// - Session.agentMemoryA.privateBrief が OwnBrief<"A"> 型として静的解決される
// - Session.agentMemoryB.privateBrief が OwnBrief<"B"> 型として静的解決される
// - publicGoal / privateGoal が分かれて存在する
// - agentMemoryA と agentMemoryB は別インスタンス（architecture.md §4.1）

test('Session.agentMemoryA は AgentMemory<"A"> 型として静的解決される', () => {
  const session = new Session({ id: "s-mem-a", guildId: "g-1" });

  // 型レベル narrow（DoD #2）
  const memoryA: AgentMemory<"A"> = session.agentMemoryA;
  assert.equal(memoryA.side, "A");
  assert.ok(memoryA instanceof AgentMemory);
});

test('Session.agentMemoryB は AgentMemory<"B"> 型として静的解決される', () => {
  const session = new Session({ id: "s-mem-b", guildId: "g-1" });

  // 型レベル narrow（DoD #3）
  const memoryB: AgentMemory<"B"> = session.agentMemoryB;
  assert.equal(memoryB.side, "B");
  assert.ok(memoryB instanceof AgentMemory);
});

test('agentMemoryA.privateBrief は OwnBrief<"A"> として代入・参照できる', () => {
  const session = new Session({ id: "s-brief-a", guildId: "g-1" });
  session.agentMemoryA.privateBrief = asOwnBrief("A", "Aの本音");

  const checked: OwnBrief<"A"> = session.agentMemoryA.privateBrief;
  assert.equal(checked, "Aの本音");
});

test('agentMemoryB.privateBrief は OwnBrief<"B"> として代入・参照できる', () => {
  const session = new Session({ id: "s-brief-b", guildId: "g-1" });
  session.agentMemoryB.privateBrief = asOwnBrief("B", "Bの本音");

  const checked: OwnBrief<"B"> = session.agentMemoryB.privateBrief;
  assert.equal(checked, "Bの本音");
});

test("agentMemoryA と agentMemoryB は別インスタンス（architecture.md §4.1: 共有フィールドなし）", () => {
  const session = new Session({ id: "s-isolation", guildId: "g-1" });

  // 別インスタンス
  assert.notEqual(
    session.agentMemoryA as unknown,
    session.agentMemoryB as unknown,
    "A と B は別インスタンス"
  );

  // 一方の更新が他方に波及しない
  session.agentMemoryA.publicGoal = "Aの公開ゴール";
  session.agentMemoryB.publicGoal = "Bの公開ゴール";
  session.agentMemoryA.strategyNotes.push({
    addedAt: 1,
    content: "Aの戦術",
    source: "external",
  });

  assert.equal(session.agentMemoryA.publicGoal, "Aの公開ゴール");
  assert.equal(session.agentMemoryB.publicGoal, "Bの公開ゴール");
  assert.equal(session.agentMemoryA.strategyNotes.length, 1);
  assert.equal(
    session.agentMemoryB.strategyNotes.length,
    0,
    "B 側のノートに A 側の戦術が混入しない"
  );
});

test("publicGoal / privateGoal がフィールドとして両側に存在する（DoD #4）", () => {
  const session = new Session({ id: "s-goal-split", guildId: "g-1" });

  // 両側に publicGoal / privateGoal フィールドが存在することを ownProperty で確認
  assert.ok("publicGoal" in session.agentMemoryA);
  assert.ok("privateGoal" in session.agentMemoryA);
  assert.ok("publicGoal" in session.agentMemoryB);
  assert.ok("privateGoal" in session.agentMemoryB);

  // 双方 null で初期化されている
  assert.equal(session.agentMemoryA.publicGoal, null);
  assert.equal(session.agentMemoryA.privateGoal, null);
  assert.equal(session.agentMemoryB.publicGoal, null);
  assert.equal(session.agentMemoryB.privateGoal, null);
});

test("Session 作成直後は両 AgentMemory が初期空状態", () => {
  const session = new Session({ id: "s-fresh", guildId: "g-1" });

  for (const memory of [session.agentMemoryA, session.agentMemoryB]) {
    assert.equal(memory.privateBrief, "");
    assert.equal(memory.privateGoal, null);
    assert.equal(memory.publicGoal, null);
    assert.equal(memory.briefSummary, null);
    assert.equal(memory.confirmedAt, null);
    assert.deepEqual(memory.rawInputs, []);
    assert.deepEqual(memory.strategyNotes, []);
    assert.deepEqual(memory.hearingHistory, []);
  }
});
