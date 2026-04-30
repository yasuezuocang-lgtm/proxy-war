import test from "node:test";
import assert from "node:assert/strict";
import { SessionStateMachine } from "./SessionStateMachine.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";

// APPEAL_WINDOW_MS 経過時の AppealExpired イベント。
// タイマー駆動は DebateCoordinator 側の責務だが、ここでは純粋関数としての
// 状態遷移と返却イベントの形を検証する。
function makeAppealPendingSession(
  courtLevel: "district" | "high" | "supreme" = "district"
): Session {
  const session = new Session({
    id: "expire-session",
    guildId: "guild-expire",
    policy: new SessionPolicy({
      maxTurns: 2,
      maxAppeals: 2,
      appealTimeoutMs: 600_000,
    }),
  });
  session.createRound(courtLevel);
  session.phase = "appeal_pending";
  session.appealableSides = ["B"];
  return session;
}

test("expireAppeal は appeal_pending から finished に遷移して appealableSides を空にする", () => {
  const stateMachine = new SessionStateMachine();
  const session = makeAppealPendingSession("district");

  const event = stateMachine.expireAppeal(session);

  assert.equal(session.phase, "finished");
  assert.deepEqual(session.appealableSides, []);
  assert.equal(event.type, "AppealExpired");
  assert.equal(event.sessionId, "expire-session");
  assert.equal(event.closedAtCourtLevel, "district");
  assert.ok(Number.isFinite(event.expiredAt));
});

test("expireAppeal は appeal_pending 以外のフェーズでは DomainError を投げる", () => {
  const stateMachine = new SessionStateMachine();
  const session = makeAppealPendingSession("district");
  session.phase = "debating";

  assert.throws(() => stateMachine.expireAppeal(session), /許可されていない/);
});

test("最高裁から expireAppeal された場合は closedAtCourtLevel=supreme がイベントに乗る", () => {
  const stateMachine = new SessionStateMachine();
  const session = makeAppealPendingSession("supreme");

  const event = stateMachine.expireAppeal(session);

  assert.equal(event.closedAtCourtLevel, "supreme");
  assert.equal(session.phase, "finished");
});
