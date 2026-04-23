import test from "node:test";
import assert from "node:assert/strict";
import {
  guidanceFor,
  type Guidance,
  type TransitionEvent,
} from "./GuidanceMessages.js";
import { SessionStateMachine } from "./SessionStateMachine.js";
import { Session } from "../../domain/entities/Session.js";
import {
  SessionPolicy,
  type SessionPolicyParams,
} from "../../domain/policies/SessionPolicy.js";
import type { HearingRequest } from "../../domain/entities/HearingRequest.js";
import type { Judgment } from "../../domain/entities/Judgment.js";

// SessionStateMachine に listener を刺した状態で各遷移を呼び、
// 発火した TransitionEvent と guidanceFor() の出力を1つのテストで組み合わせ検証する。
// 方針: pure 関数 guidanceFor の単体テストに加え、
// SessionStateMachine がその入力となるイベントを正しく emit することも保証する。
function createSession(policyParams: SessionPolicyParams = {}): {
  session: Session;
  events: TransitionEvent[];
  stateMachine: SessionStateMachine;
} {
  const events: TransitionEvent[] = [];
  const stateMachine = new SessionStateMachine((event) => {
    events.push(event);
  });
  const session = new Session({
    id: "guidance-test",
    guildId: "guild-guidance",
    policy: new SessionPolicy({
      maxTurns: 2,
      maxAppeals: 2,
      appealTimeoutMs: 1000,
      ...policyParams,
    }),
  });
  return { session, events, stateMachine };
}

function makeJudgment(
  winner: Judgment["winner"],
  summary = "total judgment"
): Judgment {
  return {
    winner,
    criteria: [],
    totalA: 10,
    totalB: 10,
    summary,
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
  };
}

test("guidanceFor: moved_to_confirming は該当サイドへのDM案内を1件返す", () => {
  const messages = guidanceFor({ type: "moved_to_confirming", side: "A" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "dm");
  assert.equal(messages[0].target === "dm" ? messages[0].side : null, "A");
  assert.match(messages[0].text, /はい/);
});

test("guidanceFor: moved_to_goal_setting はゴール設定案内（SPEC §7.2準拠）を返す", () => {
  const messages = guidanceFor({ type: "moved_to_goal_setting", side: "B" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "dm");
  assert.equal(messages[0].target === "dm" ? messages[0].side : null, "B");
  assert.match(messages[0].text, /ゴール/);
  assert.match(messages[0].text, /なし/);
});

test("guidanceFor: participant_ready は両者完了時のみ #talk 通知を返す", () => {
  const notReady = guidanceFor({
    type: "participant_ready",
    side: "A",
    sessionReady: false,
  });
  assert.equal(notReady.length, 1);
  assert.equal(notReady[0].target, "dm");

  const ready = guidanceFor({
    type: "participant_ready",
    side: "B",
    sessionReady: true,
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].target, "talk");
  assert.match(ready[0].text, /両者|#talk/);
});

test("guidanceFor: judging_completed(appeal_pending) は敗者/両者に上告案内DMを返す", () => {
  const loserOnly = guidanceFor({
    type: "judging_completed",
    phase: "appeal_pending",
    winner: "A",
    courtLevel: "district",
    appealableSides: ["B"],
  });
  assert.equal(loserOnly.length, 1);
  assert.equal(loserOnly[0].target, "dm");
  assert.equal(loserOnly[0].target === "dm" ? loserOnly[0].side : null, "B");
  assert.match(loserOnly[0].text, /上告/);

  const drawBoth = guidanceFor({
    type: "judging_completed",
    phase: "appeal_pending",
    winner: "draw",
    courtLevel: "district",
    appealableSides: ["A", "B"],
  });
  assert.equal(drawBoth.length, 2);
  const sides = drawBoth.map((g: Guidance) =>
    g.target === "dm" ? g.side : null
  );
  assert.deepEqual(sides.sort(), ["A", "B"]);
});

test("guidanceFor: judging_completed(finished, supreme) は最終審の確定案内を返す", () => {
  const messages = guidanceFor({
    type: "judging_completed",
    phase: "finished",
    winner: "A",
    courtLevel: "supreme",
    appealableSides: [],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "talk");
  assert.match(messages[0].text, /最終審|決着/);
});

test("guidanceFor: appeal_accepted は #talk に次審案内を返す", () => {
  const messages = guidanceFor({
    type: "appeal_accepted",
    appellantSide: "B",
    nextCourtLevel: "high",
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "talk");
  assert.match(messages[0].text, /高等裁判所/);
  assert.match(messages[0].text, /B/);
});

test("guidanceFor: appeal_expired は #talk に確定案内を返す", () => {
  const messages = guidanceFor({
    type: "appeal_expired",
    closedAtCourtLevel: "district",
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "talk");
  assert.match(messages[0].text, /異議なし|確定/);
});

test("SessionStateMachine: preparing 系の遷移で各 TransitionEvent を emit する", () => {
  const { session, events, stateMachine } = createSession();

  stateMachine.startInput(session, "A");
  // startInput はイベント対象外（入力フェーズは毎メッセージの確認で案内しないため）
  assert.equal(events.length, 0);

  stateMachine.moveToConfirming(session, "A");
  assert.equal(events.at(-1)?.type, "moved_to_confirming");

  stateMachine.moveToGoalSetting(session, "A");
  assert.equal(events.at(-1)?.type, "moved_to_goal_setting");

  stateMachine.markParticipantReady(session, "A", "ゴールA");
  const readyEventA = events.at(-1);
  assert.equal(readyEventA?.type, "participant_ready");
  assert.equal(
    readyEventA?.type === "participant_ready" ? readyEventA.sessionReady : null,
    false
  );

  stateMachine.startInput(session, "B");
  stateMachine.moveToConfirming(session, "B");
  stateMachine.moveToGoalSetting(session, "B");
  stateMachine.markParticipantReady(session, "B");
  const readyEventB = events.at(-1);
  assert.equal(
    readyEventB?.type === "participant_ready" ? readyEventB.sessionReady : null,
    true
  );
});

test("SessionStateMachine: debate_started / hearing / round_finished / judging_completed を emit する", () => {
  const { session, events, stateMachine } = createSession();

  // 両者 ready にしてから対話開始
  stateMachine.startInput(session, "A");
  stateMachine.moveToConfirming(session, "A");
  stateMachine.moveToGoalSetting(session, "A");
  stateMachine.markParticipantReady(session, "A");
  stateMachine.startInput(session, "B");
  stateMachine.moveToConfirming(session, "B");
  stateMachine.moveToGoalSetting(session, "B");
  stateMachine.markParticipantReady(session, "B");
  events.length = 0;

  stateMachine.startDebate(session, "district");
  assert.equal(events.at(-1)?.type, "debate_started");

  const hearing: HearingRequest = {
    requestedBy: "A",
    targetSide: "A",
    question: "確認",
    context: "直前の発言",
    createdAt: Date.now(),
    answeredAt: null,
    answer: null,
  };
  stateMachine.requestHearing(session, hearing);
  const hearingStarted = events.at(-1);
  assert.equal(hearingStarted?.type, "hearing_started");
  assert.equal(
    hearingStarted?.type === "hearing_started"
      ? hearingStarted.targetSide
      : null,
    "A"
  );

  stateMachine.resolveHearing(session, "追加情報");
  assert.equal(events.at(-1)?.type, "hearing_resolved");

  stateMachine.finishRound(session);
  assert.equal(events.at(-1)?.type, "round_finished");

  stateMachine.completeJudging(session, makeJudgment("A"));
  const judged = events.at(-1);
  assert.equal(judged?.type, "judging_completed");
  assert.equal(
    judged?.type === "judging_completed" ? judged.phase : null,
    "appeal_pending"
  );
});

test("SessionStateMachine: 上告枠ゼロで completeJudging すると phase=finished のイベントになる", () => {
  const { session, events, stateMachine } = createSession({ maxAppeals: 0 });

  stateMachine.startInput(session, "A");
  stateMachine.moveToConfirming(session, "A");
  stateMachine.moveToGoalSetting(session, "A");
  stateMachine.markParticipantReady(session, "A");
  stateMachine.startInput(session, "B");
  stateMachine.moveToConfirming(session, "B");
  stateMachine.moveToGoalSetting(session, "B");
  stateMachine.markParticipantReady(session, "B");
  stateMachine.startDebate(session, "district");
  stateMachine.finishRound(session);
  events.length = 0;

  stateMachine.completeJudging(session, makeJudgment("A"));
  const judged = events.at(-1);
  assert.equal(judged?.type, "judging_completed");
  assert.equal(
    judged?.type === "judging_completed" ? judged.phase : null,
    "finished"
  );
});

test("SessionStateMachine: expireAppeal / acceptAppeal / archive / reset を emit する", () => {
  const { session, events, stateMachine } = createSession();

  // 地裁ラウンドまで進めて appeal_pending を作る
  stateMachine.startInput(session, "A");
  stateMachine.moveToConfirming(session, "A");
  stateMachine.moveToGoalSetting(session, "A");
  stateMachine.markParticipantReady(session, "A");
  stateMachine.startInput(session, "B");
  stateMachine.moveToConfirming(session, "B");
  stateMachine.moveToGoalSetting(session, "B");
  stateMachine.markParticipantReady(session, "B");
  stateMachine.startDebate(session, "district");
  stateMachine.finishRound(session);
  stateMachine.completeJudging(session, makeJudgment("A"));
  events.length = 0;

  stateMachine.acceptAppeal(session, {
    appellantSide: "B",
    content: "異議",
    createdAt: Date.now(),
  });
  const accepted = events.at(-1);
  assert.equal(accepted?.type, "appeal_accepted");
  assert.equal(
    accepted?.type === "appeal_accepted" ? accepted.nextCourtLevel : null,
    "high"
  );

  // 高裁ラウンドで再度 appeal_pending にして expire する
  stateMachine.completeJudging(session, makeJudgment("A"));
  events.length = 0;
  stateMachine.expireAppeal(session);
  assert.equal(events.at(-1)?.type, "appeal_expired");

  stateMachine.archive(session);
  assert.equal(events.at(-1)?.type, "archived");

  stateMachine.reset(session);
  assert.equal(events.at(-1)?.type, "reset");
});

test("SessionStateMachine+guidanceFor: moved_to_goal_setting の案内が SPEC §7.2 の例と整合する", () => {
  const { session, events, stateMachine } = createSession();

  stateMachine.startInput(session, "A");
  stateMachine.moveToConfirming(session, "A");
  stateMachine.moveToGoalSetting(session, "A");

  const event = events.at(-1);
  assert.ok(event);
  const messages = guidanceFor(event);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "dm");
  assert.match(messages[0].text, /ゴール/);
  assert.match(messages[0].text, /なし/);
});

test("SessionStateMachine: listener 未指定でも既存の遷移は落ちない（後方互換）", () => {
  const stateMachine = new SessionStateMachine();
  const session = new Session({
    id: "guidance-compat",
    guildId: "guild-compat",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 0 }),
  });
  stateMachine.startInput(session, "A");
  stateMachine.moveToConfirming(session, "A");
  stateMachine.moveToGoalSetting(session, "A");
  stateMachine.markParticipantReady(session, "A");
  // listener なしでもエラーが出ないことだけを確認
  assert.equal(session.participants.A.phase, "ready");
});
