import test from "node:test";
import assert from "node:assert/strict";
import { IsolationPolicy } from "./IsolationPolicy.js";
import { asOwnBrief } from "../../application/ports/ParticipantAgent.js";

test("IsolationPolicy.assertOwnBriefAccess: 自側の brief は通る", () => {
  IsolationPolicy.clearOperationLog();
  const brief = asOwnBrief("A", "Aの本音");
  IsolationPolicy.assertOwnBriefAccess("A", brief);
  // ログに残っている
  const ops = IsolationPolicy.recentOperations();
  assert.ok(ops.some((o) => o.operation.startsWith("assertOwnBrief")));
});

test("IsolationPolicy.assertOwnBriefAccess: 相手側マーカーの混入を strict で throw", () => {
  IsolationPolicy.clearOperationLog();
  // [OWN_BRIEF:B] マーカー混入を A 側にぶつける（型は asOwnBrief で偽装）。
  const tainted = asOwnBrief(
    "A",
    "Aの背景\n[OWN_BRIEF:B] Bの本音が混じった"
  );
  assert.throws(
    () => IsolationPolicy.assertOwnBriefAccess("A", tainted),
    /IsolationPolicy 違反.*B 側の brief マーカー/
  );
});

test("IsolationPolicy.assertNoOpponentMemoryRef: agentMemoryA/B フィールドを直接保持していたら throw", () => {
  IsolationPolicy.clearOperationLog();
  // 司会クラスを模した object に意図的に agentMemoryA フィールドを生やす。
  const fakeCoordinator = {
    agentMemoryA: { dummy: true },
    runDebate(): void {},
  };
  assert.throws(
    () => IsolationPolicy.assertNoOpponentMemoryRef(fakeCoordinator),
    /IsolationPolicy 違反.*agentMemoryA/
  );
});

test("IsolationPolicy.assertNoOpponentMemoryRef: 代理人記憶を持たない司会は通る", () => {
  IsolationPolicy.clearOperationLog();
  const cleanCoordinator = {
    sessionRepository: {},
    runDebate(): void {},
  };
  assert.doesNotThrow(() =>
    IsolationPolicy.assertNoOpponentMemoryRef(cleanCoordinator)
  );
});

test("IsolationPolicy.logSideOperation: 操作と側を記録する", () => {
  IsolationPolicy.clearOperationLog();
  IsolationPolicy.logSideOperation("llm.appendBrief", "A");
  IsolationPolicy.logSideOperation("dm.send", "B");

  const ops = IsolationPolicy.recentOperations();
  assert.equal(ops.length, 2);
  assert.equal(ops[0].operation, "llm.appendBrief");
  assert.equal(ops[0].side, "A");
  assert.equal(ops[1].operation, "dm.send");
  assert.equal(ops[1].side, "B");
});

test("IsolationPolicy: lenient モードでは違反でも throw せず警告のみ", () => {
  IsolationPolicy.clearOperationLog();
  const originalMode = process.env.ISOLATION_POLICY;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: unknown) => {
    warnings.push(String(msg));
  };
  try {
    process.env.ISOLATION_POLICY = "lenient";
    const tainted = asOwnBrief("A", "[OWN_BRIEF:B] 漏洩");
    // throw しない
    assert.doesNotThrow(() =>
      IsolationPolicy.assertOwnBriefAccess("A", tainted)
    );
    assert.ok(warnings.some((w) => /IsolationPolicy/.test(w)));
  } finally {
    if (originalMode === undefined) {
      delete process.env.ISOLATION_POLICY;
    } else {
      process.env.ISOLATION_POLICY = originalMode;
    }
    console.warn = originalWarn;
  }
});
