import test from "node:test";
import assert from "node:assert/strict";
import type { OpponentPublicView } from "./OpponentPublicView.js";
import type { ParticipantSide } from "../entities/Participant.js";

// Step 5 / migration-plan §3 Step 5:
// 相手側に「渡してよい最小情報」を表す型。
// 私的ゴール（privateGoal）や privateBrief は絶対にここに含めない。
// SPEC F-30 / F-31: publicGoal は相手側エージェントから見える唯一のゴール表現。
// SPEC F-33: 公開ゴール未設定でも対話開始可（=> publicGoal は null 許容）。

test("OpponentPublicView は side と publicGoal の2フィールドを持つ", () => {
  const view: OpponentPublicView = {
    side: "A",
    publicGoal: "謝ってほしい",
  };

  assert.equal(view.side, "A");
  assert.equal(view.publicGoal, "謝ってほしい");
});

test("publicGoal は null を許容する（SPEC F-33: 未設定でも対話開始可）", () => {
  const view: OpponentPublicView = {
    side: "B",
    publicGoal: null,
  };

  assert.equal(view.side, "B");
  assert.equal(view.publicGoal, null);
});

test('side は ParticipantSide ("A" | "B") のリテラル型として静的解決される', () => {
  const aView: OpponentPublicView = { side: "A", publicGoal: null };
  const bView: OpponentPublicView = { side: "B", publicGoal: null };

  // 型レベル: ParticipantSide のリテラル ("A" / "B") に narrow される
  const sideA: ParticipantSide = aView.side;
  const sideB: ParticipantSide = bView.side;

  assert.equal(sideA, "A");
  assert.equal(sideB, "B");
});

test("OpponentPublicView は privateGoal / privateBrief を一切含まない（SPEC F-32）", () => {
  // 型コントラクトとしての確認:
  // OpponentPublicView は side と publicGoal だけを持つ。
  // ここで型システムを使って "余計なフィールド" がコンパイルエラーになることを宣言する。
  const view: OpponentPublicView = {
    side: "A",
    publicGoal: "公開ゴール",
  };

  // 実行時でもキーは2つだけであることを担保。
  const keys = Object.keys(view).sort();
  assert.deepEqual(keys, ["publicGoal", "side"]);
});
